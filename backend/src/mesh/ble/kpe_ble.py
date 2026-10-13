#!/usr/bin/env python3
"""KPE mesh BLE helper (PI-MESH T6/T8).

Advertises this node's beacon, prints every KPE beacon it hears, and (T8) hands weigh rows to a neighbour over a GATT
write / accepts such rows. One JSON object per line in each direction. Talks to BlueZ over D-Bus as an ordinary user
(BlueZ's default policy allows it, no root, no group) and is asynchronous end to end: a blocking D-Bus call made from inside
the GLib mainloop deadlocks, because BlueZ calls back into this same process (Release/GetAll/WriteValue) while it waits.

stdin  (JSON lines)  {"cmd":"beacon","hex":"<26-byte payload as hex>"}    set / refresh the advertised payload
                     {"cmd":"scan","on":2,"off":8}                        software duty cycle; off = 0 -> scan continuously
                     {"cmd":"relay-serve","on":true,"sid":186,"boot":7}   register the GATT service + a small connectable advertisement naming this station
                     {"cmd":"relay-send","id":7,"sid":186,"hex":".."}      connect to that neighbour, write one frame, report the result
                     {"cmd":"relay-peers","sids":[185,186,190]}           only these stations' connectable advertisements are remembered as hand-over targets
                     {"cmd":"relay-ack","id":3,"ok":true,"why":"","ack":"<32 hex>"}  answer for a frame delivered as relay-in; `ack` is the node's proof of storage,
                                                                          which the writer reads back (a stranger's device cannot produce it)
                     {"cmd":"quit"}
stdout (JSON lines)  {"ev":"ready","adapter":"hci0","address":"..."}
                     {"ev":"beacon","hex":"...","rssi":-70,"addr":"AA:..","t":1700000000.1}
                     {"ev":"adv","ok":true} · {"ev":"error","where":"adv","msg":"..."} · {"ev":"stats",...} every 30 s
                     {"ev":"relay-in","id":3,"addr":"AA:..","hex":"..."} · {"ev":"relay-result","id":7,"ok":true,"why":"","ms":830,"ack":"<32 hex>"}

Why two advertisements: the 26-byte beacon fills a non-connectable packet (a connectable one adds 3 flag bytes and BlueZ refuses it,
"Invalid Parameters 0x0d"), and non-connectable advertising uses a rotating random address that cannot be connected to. So a relay node also
advertises a tiny CONNECTABLE packet (public address) whose manufacturer data is 0x4B | sid | boot; a sender looks the neighbour up by that sid.
Prerequisite on Pi OS Desktop images: WirePlumber's BLE-MIDI monitor must be off (installer/pi/enable-mesh-relay.sh) - it reads an encrypted MIDI
characteristic of every connecting station, which starts pairing and stalls the link.
exit   0 quit or stdin closed (the parent died)  ·  3 python modules / BlueZ / adapter missing  ·  4 bluetoothd went away

Hardware fact (measured on the Pi 5 testbed, BlueZ 5.82): the controller refuses to add or replace an advertisement while an
LE scan is running ("Failed to add advertisement: Failed (0x03)") - with continuous scanning every registration failed. An
advertisement that is already on the air keeps going while scanning. So every job that changes advertising or opens a
connection runs through one queue that pauses the scan first and resumes it afterwards (a few hundred milliseconds).
"""
import argparse, json, os, sys, time

COMPANY = 0xFFFF
PEER_MARKER = 0x4B        # first byte of the 4-byte manufacturer data of a connectable relay advertisement
SLOTS = ["/org/kpe/mesh/adv0", "/org/kpe/mesh/adv1"]
CONN_ADV = "/org/kpe/mesh/cadv0"
GATT_APP, GATT_SVC, GATT_CHR = "/org/kpe/mesh/gatt", "/org/kpe/mesh/gatt/service0", "/org/kpe/mesh/gatt/service0/char0"
SVC_UUID = "8f3c0001-4b50-4500-9a11-0a5c4d3e0001"
CHR_UUID = "8f3c0002-4b50-4500-9a11-0a5c4d3e0001"
BUS_NAME, ADV_MGR, ADV_IFACE, DEV_IFACE, ADAPTER_IFACE, PROPS, OBJMGR = (
    "org.bluez", "org.bluez.LEAdvertisingManager1", "org.bluez.LEAdvertisement1", "org.bluez.Device1", "org.bluez.Adapter1",
    "org.freedesktop.DBus.Properties", "org.freedesktop.DBus.ObjectManager")
GATT_MGR, GATT_CHR_IFACE, GATT_SVC_IFACE = "org.bluez.GattManager1", "org.bluez.GattCharacteristic1", "org.bluez.GattService1"
WRITE_WAIT_S = 8         # how long the relay side may take to store a frame before the write is failed
SEND_LIMIT_S = 25        # hard limit for one hand-over job
IDLE_DISCONNECT_S = 4    # keep a connection this long after a write so the next row can reuse it


def emit(**kw):
    try:
        sys.stdout.write(json.dumps(kw, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, ValueError):     # the parent went away: nobody is listening, so stop too
        os._exit(0)


try:
    import dbus, dbus.exceptions, dbus.mainloop.glib, dbus.service
    from gi.repository import GLib
except ImportError as e:
    emit(ev="error", where="import", msg=str(e)[:160])
    sys.exit(3)


class Adv(dbus.service.Object):
    """A LEAdvertisement1: kind 'beacon' = non-connectable manufacturer data, kind 'connectable' = peripheral advertising our service + 4 marker bytes."""
    def __init__(self, bus, path, kind, payload, on_release):
        self.kind, self.payload, self.on_release = kind, payload, on_release
        super().__init__(bus, path)

    def _props(self):
        if self.kind == "beacon":
            md = dbus.Dictionary({dbus.UInt16(COMPANY): dbus.Array([dbus.Byte(b) for b in self.payload], signature="y")}, signature="qv")
            return {"Type": dbus.String("broadcast"), "ManufacturerData": md, "Discoverable": dbus.Boolean(False)}
        md = dbus.Dictionary({dbus.UInt16(COMPANY): dbus.Array([dbus.Byte(b) for b in self.payload], signature="y")}, signature="qv")
        return {"Type": dbus.String("peripheral"), "ManufacturerData": md, "ServiceUUIDs": dbus.Array([SVC_UUID], signature="s"), "Discoverable": dbus.Boolean(False)}

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, iface):
        return self._props()

    @dbus.service.method(PROPS, in_signature="ss", out_signature="v")
    def Get(self, iface, prop):
        return self._props()[prop]

    @dbus.service.method(ADV_IFACE, in_signature="", out_signature="")
    def Release(self):
        self.on_release(self)


class GattApp(dbus.service.Object):
    def __init__(self, bus): super().__init__(bus, GATT_APP)

    @dbus.service.method(OBJMGR, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        return {
            dbus.ObjectPath(GATT_SVC): {GATT_SVC_IFACE: {"UUID": SVC_UUID, "Primary": dbus.Boolean(True)}},
            dbus.ObjectPath(GATT_CHR): {GATT_CHR_IFACE: {"UUID": CHR_UUID, "Service": dbus.ObjectPath(GATT_SVC), "Flags": dbus.Array(["read", "write"], signature="s")}},
        }


class GattService(dbus.service.Object):
    def __init__(self, bus): super().__init__(bus, GATT_SVC)
    def _p(self): return {"UUID": SVC_UUID, "Primary": dbus.Boolean(True)}

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, i): return self._p()

    @dbus.service.method(PROPS, in_signature="ss", out_signature="v")
    def Get(self, i, p): return self._p()[p]


class GattChar(dbus.service.Object):
    def __init__(self, bus, on_write, on_read):
        super().__init__(bus, GATT_CHR)
        self.on_write, self.on_read = on_write, on_read

    def _p(self): return {"UUID": CHR_UUID, "Service": dbus.ObjectPath(GATT_SVC), "Flags": dbus.Array(["read", "write"], signature="s")}

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, i): return self._p()

    @dbus.service.method(PROPS, in_signature="ss", out_signature="v")
    def Get(self, i, p): return self._p()[p]

    # reading returns the proof of storage for the last frame THIS device wrote (empty for anyone else)
    @dbus.service.method(GATT_CHR_IFACE, in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options):
        return dbus.Array([dbus.Byte(b) for b in self.on_read(str(options.get("device", "")))], signature="y")

    # the reply is given later, when the node has stored the frame: async callbacks keep the mainloop free
    @dbus.service.method(GATT_CHR_IFACE, in_signature="aya{sv}", out_signature="", async_callbacks=("ok", "err"))
    def WriteValue(self, value, options, ok, err):
        self.on_write(bytes(bytearray(int(x) for x in value)), str(options.get("device", "")), ok, err)


def addr_of(path):
    return str(path).rsplit("dev_", 1)[-1].replace("_", ":")


class Helper:
    def __init__(self, adapter):
        self.adapter_name = adapter
        dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
        try:
            self.bus = dbus.SystemBus()
        except dbus.exceptions.DBusException as e:
            emit(ev="error", where="dbus", msg=str(e)[:160])
            sys.exit(3)
        self.loop = GLib.MainLoop()
        self.exit_code = 0
        self.adapter_path = "/org/bluez/" + adapter
        try:
            obj = self.bus.get_object(BUS_NAME, self.adapter_path)
            self.adapter = dbus.Interface(obj, ADAPTER_IFACE)
            self.props = dbus.Interface(obj, PROPS)
            self.mgr = dbus.Interface(obj, ADV_MGR)
            self.gatt_mgr = dbus.Interface(obj, GATT_MGR)
            self.address = str(self.props.Get(ADAPTER_IFACE, "Address"))
            self.powered = bool(self.props.Get(ADAPTER_IFACE, "Powered"))
        except dbus.exceptions.DBusException as e:
            emit(ev="error", where="adapter", msg=str(e)[:160])
            sys.exit(3)
        # job queue: everything that changes advertising or opens a connection runs here, one at a time, with the scan paused
        self.queue, self.queued, self.working = [], set(), False
        self.resume_scan = False  # the scan was paused only for a job: start it again afterwards
        # beacon
        self.want = None          # newest payload asked for
        self.live = None          # registered beacon Adv
        self.live_payload = None
        self.fails = 0
        self.regs = 0
        self.pending_unreg = set()
        # relay server
        self.serve = False
        self.serve_sid, self.serve_boot = 0, 0
        self.served = False       # GATT app + connectable advertisement are registered
        self.app_registered = False   # RegisterApplication succeeded (so it must be unregistered before a retry)
        self.peers = {}           # sid -> {"path", "t"} of neighbours whose connectable advertisement we have seen (capped, see _note_peer)
        self.peer_paths = {}      # device path -> sid (O(1) refresh when a report arrives for a known peer)
        self.allowed_peers = None # None = any station number; else the set the node told us about (a stranger cycling markers cannot fill the table)
        self.conn_adv = None
        self.gatt_objs = []
        self.writes = {}          # id -> (ok, err, timer, device)
        self.last_ack = {}        # writer device path -> proof of storage for its last frame (what a read-back returns)
        self.write_seq = 0
        # relay client
        self.conn = None          # {"addr","path","chr","last"} of an open connection
        self.conn_timer = None
        # scanning
        self.scan_on, self.scan_off = 2.0, 8.0
        self.scanning = False
        self.scan_busy = False    # a StartDiscovery / StopDiscovery call is in flight
        self.want_scan = False
        self.scan_timer = None    # the single pending on/off switch
        self.dev = {}             # device path -> {"hex", "rssi", "emitted"}
        self.last_prune = 0.0
        self.reports = 0
        self.emitted = 0
        self.stdin_buf = b""

    # ------------------------------------------------------------------ job queue
    def _enqueue(self, name, fn):
        if name in self.queued:               # coalesce: one pending job per name (a newer beacon replaces an older one)
            return
        self.queued.add(name)
        self.queue.append((name, fn))
        self._pump()

    def _pump(self):
        if self.working or not self.queue:
            return
        if self.scan_busy:                    # a scan start/stop is in flight: starting a job now would race it
            GLib.timeout_add(300, lambda: (self._pump(), False)[1]); return
        if self.scanning:
            self._pause_scan(self._pump); return
        name, fn = self.queue.pop(0)
        self.queued.discard(name)
        self.working = True
        state = {"done": False}

        def done():
            if state["done"]:
                return
            state["done"] = True
            self.working = False
            if self.resume_scan:
                self.resume_scan = False
                self._scan_start()
            GLib.idle_add(lambda: (self._pump(), False)[1])

        try:
            fn(done)
        except Exception as e:                # a broken job must not wedge the queue
            emit(ev="error", where="job:" + name, msg=str(e)[:160])
            done()

    # ------------------------------------------------------------------ beacon
    def set_beacon(self, hexstr):
        try:
            payload = bytes.fromhex(hexstr)
        except ValueError:
            emit(ev="error", where="beacon", msg="bad hex"); return
        if not 1 <= len(payload) <= 27:
            emit(ev="error", where="beacon", msg="payload length %d not in 1..27" % len(payload)); return
        self.want = payload
        self._enqueue("beacon", self._job_beacon)

    def _job_beacon(self, done):
        if self.want is None or self.want == self.live_payload:
            done(); return
        slot = 0 if self.live is None else (1 - SLOTS.index(self.live._object_path))
        path = SLOTS[slot]
        if path in self.pending_unreg:        # the previous holder of this slot is still being removed: try again shortly (by timer, not by spinning)
            done()
            GLib.timeout_add(500, lambda: (self._enqueue("beacon", self._job_beacon), False)[1]); return
        payload = self.want
        adv = Adv(self.bus, path, "beacon", payload, self._released)

        def ok():
            old = self.live
            self.live, self.live_payload, self.fails = adv, payload, 0
            self.regs += 1
            emit(ev="adv", ok=True)
            if old is not None:
                self._drop(old)
            done()
            if self.want != self.live_payload:
                self._enqueue("beacon", self._job_beacon)

        def err(e):
            self.fails += 1
            try: adv.remove_from_connection()
            except Exception: pass
            emit(ev="error", where="adv", msg=str(e)[:160])
            done()
            GLib.timeout_add(int(min(30, 2 ** self.fails) * 1000), lambda: (self._enqueue("beacon", self._job_beacon), False)[1])

        self.mgr.RegisterAdvertisement(path, {}, reply_handler=ok, error_handler=err)

    def _drop(self, adv):
        path = adv._object_path
        self.pending_unreg.add(path)

        def done(*_):
            self.pending_unreg.discard(path)
            try: adv.remove_from_connection()
            except Exception: pass

        self.mgr.UnregisterAdvertisement(path, reply_handler=done, error_handler=lambda e: done())

    def _released(self, adv):                     # BlueZ dropped us (adapter reset): free the exported paths and put things back
        emit(ev="error", where="adv", msg="released by bluez")
        if adv is self.live:
            try: adv.remove_from_connection()         # the path must be free again or the next registration at it raises KeyError inside the job
            except Exception: pass
            self.live, self.live_payload = None, None
            GLib.idle_add(lambda: (self._enqueue("beacon", self._job_beacon), False)[1])
        elif adv is self.conn_adv:
            for o in self.gatt_objs + [adv]:
                try: o.remove_from_connection()
                except Exception: pass
            self.gatt_objs, self.conn_adv, self.served, self.app_registered = [], None, False, False
            if self.serve:
                GLib.idle_add(lambda: (self._enqueue("serve", self._job_serve), False)[1])

    # ------------------------------------------------------------------ relay: server side
    def relay_serve(self, on, sid=0, boot=0):
        self.serve = bool(on)
        if on:
            self.serve_sid, self.serve_boot = int(sid) & 0xFFFF, int(boot) & 0xFF
        self._enqueue("serve", self._job_serve)

    def _marker(self):
        return bytes([PEER_MARKER, self.serve_sid >> 8, self.serve_sid & 0xFF, self.serve_boot])

    def _job_serve(self, done):
        if self.serve and not self.served:
            objs = [GattApp(self.bus), GattService(self.bus), GattChar(self.bus, self._on_write, self._on_read)]
            adv = Adv(self.bus, CONN_ADV, "connectable", self._marker(), self._released)

            def cleanup():
                for o in objs + [adv]:
                    try: o.remove_from_connection()
                    except Exception: pass
                self.app_registered = False
                done()
                GLib.timeout_add(15000, lambda: (self._enqueue("serve", self._job_serve), False)[1])

            def fail(e):
                emit(ev="error", where="relay-serve", msg=str(e)[:160])
                if self.app_registered:                    # the application half succeeded: take it down, or every retry hits AlreadyExists
                    self.gatt_mgr.UnregisterApplication(GATT_APP, reply_handler=cleanup, error_handler=lambda e2: cleanup())
                else:
                    cleanup()

            def adv_ok():
                self.gatt_objs, self.conn_adv, self.served = objs, adv, True
                emit(ev="adv", ok=True, kind="relay")
                done()

            def app_ok():
                self.app_registered = True
                self.mgr.RegisterAdvertisement(CONN_ADV, {}, reply_handler=adv_ok, error_handler=fail)

            self.gatt_mgr.RegisterApplication(GATT_APP, {}, reply_handler=app_ok, error_handler=fail)
        elif not self.serve and self.served:
            def gone(*_):
                for o in self.gatt_objs + ([self.conn_adv] if self.conn_adv else []):
                    try: o.remove_from_connection()
                    except Exception: pass
                self.gatt_objs, self.conn_adv, self.served, self.app_registered = [], None, False, False
                done()
            self.mgr.UnregisterAdvertisement(CONN_ADV, reply_handler=lambda: self.gatt_mgr.UnregisterApplication(GATT_APP, reply_handler=gone, error_handler=gone), error_handler=gone)
        else:
            done()

    def _on_write(self, data, device, ok, err):
        self.write_seq += 1
        wid = self.write_seq

        def expire():
            if self.writes.pop(wid, None) is not None:
                err(dbus.exceptions.DBusException("relay: node did not answer in time", name="org.bluez.Error.Failed"))
            return False

        self.writes[wid] = (ok, err, GLib.timeout_add(WRITE_WAIT_S * 1000, expire), device)
        emit(ev="relay-in", id=wid, addr=addr_of(device), hex=data.hex())

    def _on_read(self, device):
        return self.last_ack.get(device, b"")

    def relay_ack(self, wid, good, why, ack=""):
        w = self.writes.pop(int(wid), None)
        if w is None:
            return
        ok, err, timer, device = w
        GLib.source_remove(timer)
        if good:
            try:
                if ack:
                    if len(self.last_ack) > 32: self.last_ack.clear()
                    self.last_ack[device] = bytes.fromhex(ack)
            except ValueError:
                pass
            ok()
        else:
            err(dbus.exceptions.DBusException("relay: " + (why or "refused"), name="org.bluez.Error.Failed"))

    # ------------------------------------------------------------------ relay: client side
    def relay_send(self, sid, peer, hexstr):
        try:
            data = bytes.fromhex(hexstr)
            if not 1 <= len(data) <= 512: raise ValueError
        except ValueError:
            emit(ev="relay-result", id=sid, ok=False, why="bad-request", ms=0); return
        self._enqueue("send:%d" % sid, lambda done: self._job_send(done, sid, int(peer), data))

    def _job_send(self, done, sid, peer, data):
        t0 = time.time()
        st = {"finished": False}
        known = self.peers.get(peer)
        if known is None or t0 - known["t"] > 180:
            emit(ev="relay-result", id=sid, ok=False, why="peer-not-seen", ms=0)
            done(); return
        path = known["path"]
        addr = addr_of(path)

        def finish(good, why="", ack=""):
            if st["finished"]:
                return
            st["finished"] = True
            GLib.source_remove(guard)
            # wt: our wall clock (ms) when the neighbour acknowledged the write - it stamps its time just before that (clock from neighbours)
            emit(ev="relay-result", id=sid, ok=good, why=why, ms=int((time.time() - t0) * 1000), ack=ack, wt=st.get("wt"))
            if good: self._arm_idle_disconnect()
            else: self._disconnect()
            done()

        guard = GLib.timeout_add(SEND_LIMIT_S * 1000, lambda: (finish(False, "timeout"), False)[1])

        def write(chr_path):
            ch = dbus.Interface(self.bus.get_object(BUS_NAME, chr_path), GATT_CHR_IFACE)
            def written():                                   # the neighbour accepted the write: now ask it for its proof of storage
                st["wt"] = int(time.time() * 1000)
                ch.ReadValue({}, reply_handler=lambda v: finish(True, "", bytes(bytearray(int(x) for x in v)).hex()),
                             error_handler=lambda e: finish(False, "no-ack: " + str(e)[:60]), timeout=WRITE_WAIT_S)
            ch.WriteValue(dbus.Array([dbus.Byte(b) for b in data], signature="y"), {},
                          reply_handler=written, error_handler=lambda e: finish(False, "write: " + str(e)[:80]), timeout=WRITE_WAIT_S + 5)

        if self.conn and self.conn["addr"] == addr and self.conn.get("chr"):     # still connected from the previous row
            write(self.conn["chr"]); return
        self._disconnect()
        try:
            dev = dbus.Interface(self.bus.get_object(BUS_NAME, path), DEV_IFACE)
            dprops = dbus.Interface(self.bus.get_object(BUS_NAME, path), PROPS)
        except dbus.exceptions.DBusException as e:
            finish(False, "no-device"); return

        def find_chr():
            def got(objs):
                for p, ifs in objs.items():
                    c = ifs.get(GATT_CHR_IFACE)
                    if c and str(c.get("UUID")) == CHR_UUID and str(p).startswith(path):
                        self.conn = {"addr": addr, "path": path, "chr": str(p), "last": time.time()}
                        write(str(p)); return
                finish(False, "no-service")
            dbus.Interface(self.bus.get_object(BUS_NAME, "/"), OBJMGR).GetManagedObjects(reply_handler=got, error_handler=lambda e: finish(False, "objects: " + str(e)[:60]))

        def poll(n=0):
            def resolved(v):
                if bool(v): find_chr()
                elif n > 60: finish(False, "services-not-resolved")
                else: GLib.timeout_add(250, lambda: (poll(n + 1), False)[1])
            dprops.Get(DEV_IFACE, "ServicesResolved", reply_handler=resolved, error_handler=lambda e: finish(False, "poll: " + str(e)[:60]))

        dev.Connect(reply_handler=poll, error_handler=lambda e: finish(False, "connect: " + str(e)[:80]), timeout=SEND_LIMIT_S)

    def _arm_idle_disconnect(self):
        if self.conn_timer is not None:
            GLib.source_remove(self.conn_timer)
        self.conn_timer = GLib.timeout_add(IDLE_DISCONNECT_S * 1000, lambda: (self._enqueue("disconnect", lambda d: (self._disconnect(), d())), False)[1])

    def _disconnect(self):
        if self.conn_timer is not None:
            GLib.source_remove(self.conn_timer); self.conn_timer = None
        c, self.conn = self.conn, None
        if c:
            try:
                dbus.Interface(self.bus.get_object(BUS_NAME, c["path"]), DEV_IFACE).Disconnect(reply_handler=lambda: None, error_handler=lambda e: None)
            except Exception:
                pass

    # ------------------------------------------------------------------ scanning
    def _schedule(self, secs, fn):
        if self.scan_timer is not None:
            GLib.source_remove(self.scan_timer)
        self.scan_timer = GLib.timeout_add(int(secs * 1000), fn)

    def _unschedule(self):
        if self.scan_timer is not None:
            GLib.source_remove(self.scan_timer)
            self.scan_timer = None

    def set_scan(self, on, off):
        self.scan_on, self.scan_off = max(0.5, float(on)), max(0.0, float(off))
        if not self.want_scan:
            self.want_scan = True
            self._scan_start()
        elif self.scanning:                        # already scanning: apply the new duty from now on
            if self.scan_off > 0: self._schedule(self.scan_on, self._scan_stop)
            else: self._unschedule()

    def _pause_scan(self, then):
        self._unschedule()
        self.scan_busy = True
        def done(*_):
            self.scan_busy = False
            self.scanning = False
            self.resume_scan = self.want_scan
            then()
        self.adapter.StopDiscovery(reply_handler=done, error_handler=done)

    def _scan_start(self):
        self.scan_timer = None                     # this call is the timer that just fired (or a direct call)
        if not self.want_scan or self.scanning or self.scan_busy:
            return False
        if self.working or self.queue:             # a job (beacon swap, connection) is running or waiting: scanning now would break it
            self._schedule(0.5, self._scan_start)
            return False
        self.scan_busy = True
        def ok():
            self.scan_busy = False
            self.scanning = True
            if self.scan_off > 0:
                self._schedule(self.scan_on, self._scan_stop)
        def err(e):
            self.scan_busy = False
            emit(ev="error", where="scan", msg=str(e)[:160])
            self._schedule(10, self._scan_start)
        try:
            self.adapter.SetDiscoveryFilter({"Transport": dbus.String("le"), "DuplicateData": dbus.Boolean(True)},
                                            reply_handler=lambda: self.adapter.StartDiscovery(reply_handler=ok, error_handler=err),
                                            error_handler=err)
        except dbus.exceptions.DBusException as e:
            err(e)
        return False

    def _scan_stop(self):
        self.scan_timer = None
        self.scan_busy = True
        def done(*_):
            self.scan_busy = False
            self.scanning = False
            if self.want_scan:
                self._schedule(self.scan_off, self._scan_start)
            self._pump()                           # the pause between scan windows is the natural moment to run queued jobs
        self.adapter.StopDiscovery(reply_handler=done, error_handler=done)
        return False

    def _note_peer(self, sid, path, now):
        if self.allowed_peers is not None and sid not in self.allowed_peers:
            return                                                     # not a station we were told about
        old = self.peers.get(sid)
        if old is not None and old["path"] != path:
            self.peer_paths.pop(old["path"], None)
        self.peers[sid] = {"path": path, "t": now}
        self.peer_paths[path] = sid
        if len(self.peers) > 128:                                      # hard cap: drop the stalest (rare; O(n) only here)
            stale = min(self.peers.items(), key=lambda kv: kv[1]["t"])[0]
            gone = self.peers.pop(stale)
            self.peer_paths.pop(gone["path"], None)

    def relay_peers(self, sids):
        try:
            self.allowed_peers = {int(x) & 0xFFFF for x in sids[:256]}
        except (TypeError, ValueError):
            self.allowed_peers = None
            return
        for sid in [k for k in self.peers if k not in self.allowed_peers]:
            gone = self.peers.pop(sid)
            self.peer_paths.pop(gone["path"], None)

    def _device(self, path, changed):
        if not str(path).startswith(self.adapter_path + "/dev_"):
            return
        now0 = time.time()
        if len(self.dev) > 300 and now0 - self.last_prune > 30:          # foreign devices fill this table: prune even when no KPE beacon is heard
            self.last_prune = now0
            self.dev = {p: v for p, v in self.dev.items() if v["hex"] is not None and now0 - v["emitted"] < 60}
            self.peers = {k2: v2 for k2, v2 in self.peers.items() if now0 - v2["t"] < 600}
            self.peer_paths = {v2["path"]: k2 for k2, v2 in self.peers.items()}
        d = self.dev.setdefault(str(path), {"hex": None, "rssi": None, "emitted": 0.0})
        md = changed.get("ManufacturerData")
        if md is not None:
            for k, v in md.items():
                if int(k) == COMPANY:
                    raw = bytes(bytearray(int(b) for b in v))
                    if len(raw) == 4 and raw[0] == PEER_MARKER:          # a neighbour's connectable relay advertisement: remember where to connect
                        self._note_peer((raw[1] << 8) | raw[2], str(path), time.time())
                        return
                    d["hex"] = raw.hex()
        if "RSSI" in changed:
            d["rssi"] = int(changed["RSSI"])
            psid = self.peer_paths.get(str(path))
            if psid is not None and psid in self.peers: self.peers[psid]["t"] = time.time()
        if d["hex"] is None:
            return
        self.reports += 1
        now = time.time()
        if now - d["emitted"] >= 1.0:              # a neighbour repeats every ~150 ms; once a second is plenty
            d["emitted"] = now
            self.emitted += 1
            emit(ev="beacon", hex=d["hex"], rssi=d["rssi"], addr=addr_of(path), t=round(now, 3))


    def _on_props(self, iface, changed, invalidated, path=None):
        if iface == DEV_IFACE:
            self._device(path, changed)
        elif iface == ADAPTER_IFACE and str(path) == self.adapter_path and "Discovering" in changed:
            if not bool(changed["Discovering"]) and self.scanning and self.scan_off == 0 and self.want_scan:
                self.scanning = False               # BlueZ stopped scanning on its own: bring it back
                GLib.idle_add(self._scan_start)

    def _on_added(self, path, ifaces):
        if DEV_IFACE in ifaces:
            self._device(path, ifaces[DEV_IFACE])

    # ------------------------------------------------------------------ plumbing
    def _stdin(self, fd, cond):
        if cond & (GLib.IO_HUP | GLib.IO_ERR) and not cond & GLib.IO_IN:
            self.quit(0); return False
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            self.quit(0); return False
        if not chunk:
            self.quit(0); return False
        self.stdin_buf += chunk
        if len(self.stdin_buf) > 262144:
            self.stdin_buf = b""
        while b"\n" in self.stdin_buf:
            line, self.stdin_buf = self.stdin_buf.split(b"\n", 1)
            try:
                cmd = json.loads(line.decode("utf8"))
            except ValueError:
                continue
            self._command(cmd)
        return True

    def _command(self, cmd):
        try:
            c = cmd.get("cmd")
            if c == "beacon": self.set_beacon(str(cmd.get("hex", "")))
            elif c == "scan": self.set_scan(cmd.get("on", 2), cmd.get("off", 8))
            elif c == "relay-serve": self.relay_serve(bool(cmd.get("on", True)), cmd.get("sid", 0), cmd.get("boot", 0))
            elif c == "relay-peers": self.relay_peers(cmd.get("sids") or [])
            elif c == "relay-send": self.relay_send(int(cmd.get("id", 0)), cmd.get("sid", 0), str(cmd.get("hex", "")))
            elif c == "relay-ack": self.relay_ack(cmd.get("id", 0), bool(cmd.get("ok")), str(cmd.get("why", "")), str(cmd.get("ack", "")))
            elif c == "quit": self.quit(0)
        except Exception as e:                        # one bad command must not take the helper down
            emit(ev="error", where="command", msg=str(e)[:160])

    def _stats(self):
        emit(ev="stats", reports=self.reports, emitted=self.emitted, regs=self.regs, fails=self.fails, scanning=self.scanning,
             devices=len(self.dev), serving=self.served, queue=len(self.queue), connected=bool(self.conn))
        return True

    def _name_owner(self, owner):
        if not owner:
            emit(ev="error", where="bluez", msg="bluetoothd went away")
            self.quit(4)

    def quit(self, code):
        self.exit_code = code
        try:
            self._disconnect()
            if self.live is not None:
                self.mgr.UnregisterAdvertisement(self.live._object_path, reply_handler=lambda: self.loop.quit(), error_handler=lambda e: self.loop.quit())
                GLib.timeout_add(1000, lambda: (self.loop.quit(), False)[1])
                return
        except Exception:
            pass
        self.loop.quit()

    def run(self):
        self.bus.add_signal_receiver(self._on_props, dbus_interface=PROPS, signal_name="PropertiesChanged", path_keyword="path")
        self.bus.add_signal_receiver(self._on_added, dbus_interface=OBJMGR, signal_name="InterfacesAdded")
        self.bus.watch_name_owner(BUS_NAME, self._name_owner)
        GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self._stdin)
        import signal
        for sig in (signal.SIGTERM, signal.SIGINT):
            GLib.unix_signal_add(GLib.PRIORITY_HIGH, sig, lambda: (self.quit(0), False)[1])
        GLib.timeout_add(30000, self._stats)
        if not self.powered:
            self.props.Set(ADAPTER_IFACE, "Powered", dbus.Boolean(True), reply_handler=lambda: None,
                           error_handler=lambda e: emit(ev="error", where="power", msg=str(e)[:160]))
        emit(ev="ready", adapter=self.adapter_name, address=self.address)
        self.loop.run()
        return self.exit_code


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", default="hci0")
    a = ap.parse_args()
    sys.exit(Helper(a.adapter).run())


if __name__ == "__main__":
    main()
