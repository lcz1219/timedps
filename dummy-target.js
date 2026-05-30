const http = require('http');

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    console.log('Target received body:', body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"success": true}');
  });
});

server.listen(31235, () => {
  console.log('Target server listening on 31235');
});
