// script id: script_1782794205296 | name: triger | enabled: False
// trigger: {"type": "tag_change", "deviceId": "GPIO", "tagId": "PLCSIGNAL"}


let in1 = tag('GPIO', 'PLCSIGNAL')
let in2 = tag('DATA', 'SETPOINT_OUT')



if(in1===1){
setTag('DATA', 'SETPOINT_OUT', 'set')
setTag('DATA', 'CONFIRM_BUFFER', tag('DATA', 'CONFIRM_RETURN'))
//log(tag('liquid2', 'Liquid2.LOT_RT11'))
//log(tag('DATA', 'CONFIRM_RETURN'))
//log(tag('GPIO', 'PLCSIGNAL'))

}else if(in1===0 && tag('DATA', 'SETPOINT_OUT')==='set'){
setTag('DATA', 'CONFIRM_FINAL', tag('DATA', 'CONFIRM_BUFFER'))
await db.mssql('AUTO',
  `INSERT INTO [SOI8LOG].[dbo].[kubotalog] ([station], [weig], [code]) VALUES ('SEMIRT10', '${tag('DATA', 'CONFIRM_FINAL')}', '${tag('liquid2', 'Liquid.LOT_RT10')}')`);
setTag('DATA', 'SETPOINT_OUT', '')
setTag('GPIO', 'SOUND', 1)
}else{
setTag('GPIO', 'SOUND', 0)
}