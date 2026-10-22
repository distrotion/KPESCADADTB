// OPC-UA driver — loaded lazily to avoid ESM issues with some Node versions
class OpcuaDriver {
  constructor(device) {
    this.device = device;
    this.client = null;
    this.session = null;
    this.connected = false;
  }

  async connect() {
    try {
      const opcua = await import('node-opcua');
      const { endpoint, securityMode, securityPolicy } = this.device.connection;

      this.client = opcua.OPCUAClient.create({
        endpointMustExist: false,
        connectionStrategy: { maxRetry: 1, initialDelay: 1000 },
        securityMode: opcua.MessageSecurityMode[securityMode] || opcua.MessageSecurityMode.None,
        securityPolicy: opcua.SecurityPolicy[securityPolicy] || opcua.SecurityPolicy.None,
      });

      await this.client.connect(endpoint);
      this.session = await this.client.createSession();
      this.connected = true;
      console.log(`[OPC-UA] Connected: ${this.device.name}`);
      return true;
    } catch (err) {
      this.connected = false;
      console.error(`[OPC-UA] Connect error (${this.device.name}):`, err.message);
      return false;
    }
  }

  async readTag(tag) {
    if (!this.connected || !this.session) return null;
    try {
      const dataValue = await this.session.readVariableValue(tag.nodeId);
      if (dataValue.value && dataValue.value.value !== undefined) {
        return dataValue.value.value;
      }
      return null;
    } catch {
      return null;
    }
  }

  async writeTag(tag, value) {
    if (!this.connected || !this.session) throw new Error('Not connected');
    const { DataType } = await import('node-opcua');
    const dt = (tag.dataType || '').toUpperCase();
    let opcType = DataType.Double;
    let v = value;
    switch (dt) {
      case 'BOOL': case 'BIT':
        opcType = DataType.Boolean; v = !!value && value !== 0 && value !== '0'; break;
      case 'INT16':  opcType = DataType.Int16;  v = Math.round(Number(value)); break;
      case 'UINT16': opcType = DataType.UInt16; v = Math.round(Number(value)); break;
      case 'INT32':  opcType = DataType.Int32;  v = Math.round(Number(value)); break;
      case 'UINT32': opcType = DataType.UInt32; v = Math.round(Number(value)); break;
      case 'INT64':  opcType = DataType.Int64;  v = Math.round(Number(value)); break;
      case 'UINT64': opcType = DataType.UInt64; v = Math.round(Number(value)); break;
      case 'FLOAT32': case 'REAL':
        opcType = DataType.Float; v = Number(value); break;
      case 'FLOAT64': case 'DOUBLE': case 'LREAL':
        opcType = DataType.Double; v = Number(value); break;
      case 'STRING':
        opcType = DataType.String; v = String(value); break;
      default:
        opcType = DataType.Double; v = Number(value);
    }
    await this.session.writeSingleNode(tag.nodeId, { dataType: opcType, value: v });
  }

  async disconnect() {
    try {
      if (this.session) await this.session.close();
      if (this.client) await this.client.disconnect();
    } catch (_) {}
    this.connected = false;
  }
}

module.exports = OpcuaDriver;
