// script id: script_1782791562578 | name: SEMI_SERIAL2 | enabled: False
// trigger: {"type": "serial", "deviceId": ""}

let input = trigger.raw;
let spi = [];
if (input.includes('-')) {
  spi = input.split('-');
} else {
  spi = input.split('+');
}
//flow.set("raw",spi)
//log(spi)
let spi2 = '0';
let spi3 = '0';
if (spi.length == 3) {
  spi2 = spi[2].split('');
  //    flow.set("real",spi2[0])
} else if (spi.length == 2) {
  spi2 = spi[1].split('');
  //log(spi2)
  //    flow.set("real",spi2[0])
} else {
  spi2 = '0';
  spi3 = '0';
  //   flow.set("real","0")
}

if (spi2.length > 1) {
  if (spi2[0].includes('+')) {
    if (spi2[0].split('+').length > 1) {
      spi3 = spi2[0].split('+')[1];
    }
  } else {
    spi3 = spi2[0];
  }
}

//log(spi3);
await writeTag('DATA', 'READ_RETURN', spi3)
await writeTag('DATA', 'CONFIRM_RETURN', parseInt(spi3)/100)

