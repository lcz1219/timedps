const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
  setTimeout(() => res.write('{"chunk": 1}\n'), 100);
  setTimeout(() => {
    res.write('{"chunk": 2}\n');
    res.end();
  }, 200);
});

server.listen(31235, () => {
  console.log('Target server listening on 31235');
});
