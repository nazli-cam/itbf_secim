const { v4: uuidv4 } = require('uuid');

function generateToken() {
  return uuidv4();
}

module.exports = { generateToken };
