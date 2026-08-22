// script id: script_1781080055770 | name: Serial_IN | enabled: False
// trigger: {"type": "serial", "deviceId": ""}

// trigger: serial
log('serial in:', trigger.deviceId, '=', trigger.raw);

let input = trigger.raw.replace(/[^0-9.]/g, '');

try {
  await writeTag('DATA', 'READ_RETURN', input);
} catch (e) {
  log('write fail:', e.message);
}



if (input === '0.00' || input === '0.0' || input === '0') {
  try {
    await writeTag('DATA', 'READ_RETURN', input);
  } catch (e) {
    log('write fail:', e.message);
  }
} else {
  try {
    await writeTag('DATA', 'CONFIRM_RETURN', input);
  } catch (e) {
    log('write fail:', e.message);
  }
}
