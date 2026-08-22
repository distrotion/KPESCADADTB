// script id: script_1782788600834 | name: SEMI_SERIAL | enabled: False
// trigger: {"type": "serial", "deviceId": "USB_LOADCELL"}

//await db.mssql('AUTO',
//  `INSERT INTO [SOI8LOG].[dbo].[kubotalog] ([station], [weig], [code]) VALUES ('SEMIRT10', '${tag('DATA', 'CONFIRM_FINAL')}', '${tag('liquid2', 'Liquid.LOT_RT10')}')`);
//log(trigger.raw.match(/[\d.]+/)[0]);
log(trigger.raw)
let input = parseFloat(trigger.raw.match(/[\d.]+/)[0])
log(input)
setTag('DATA', 'READ_RETURN', input)

if(input> 10){

setTag('DATA', 'CONFIRM_FINAL',tag('DATA', 'CONFIRM_BUFFER') )
log("-------2")
await db.mssql('AUTO',
  `INSERT INTO [SOI8LOG].[dbo].[kubotalog] ([station], [weig], [code]) VALUES ('LIQUID_AUTO', '${input}', '${tag('liquid2', 'Liquid.D31050')}')`);
}



