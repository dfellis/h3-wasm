const test = require('.')

console.log(test.helloWorld());
console.log(test.greet("Zig"));
console.log(test.latLngToCell(45, 40, 2));
console.log(test.cellToLatLng("822d57fffffffff"));
console.log(test.cellToBoundary("822d57fffffffff"));
console.log(test.getResolution("822d57fffffffff"));
console.log(test.isValidCell("822d57fffffffff"));
console.log(test.isResClassIII("822d57fffffffff"));
console.log(test.isPentagon("822d57fffffffff"));
console.log(test.getIcosahedronFaces("822d57fffffffff"));