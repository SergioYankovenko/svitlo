// Display spelling is retained. This comparison key never removes a slash,
// corpus, internal space, hyphen, or a distinction between Latin/Cyrillic letters.
export function houseKey(value){
 if(typeof value!=='string'||!value.trim()||value.length>120||/[\u0000-\u001f\u007f]/u.test(value))return null;
 return value.normalize('NFC').toLocaleLowerCase('uk-UA').trim();
}
export function sameHouse(a,b){const key=houseKey(a);return key!==null&&key===houseKey(b);}
export const canonicalIdentityPolicy=Object.freeze({version:1,homeKey:'canonicalAddressId',lineKey:'lineId',maxConfirmedLines:32,maxSensorsPerLine:1,retainedIdentityDays:7,geographyDefinesElectricalGroup:false});
