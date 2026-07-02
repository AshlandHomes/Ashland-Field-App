exports.handler = async function() {
  return {
    statusCode: 200,
    body: JSON.stringify({ secret: process.env.API_SHARED_SECRET || '' })
  };
};
