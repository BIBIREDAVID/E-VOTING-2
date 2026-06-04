const { handleRequest } = require('./_lib');

module.exports = async function handler(req, res) {
  return handleRequest(req, res);
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
