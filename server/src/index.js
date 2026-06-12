const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const { handleConnection } = require('./ws/handler');

const PORT = process.env.PORT || 3000;

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (socket, req) => {
  handleConnection(socket, req);
});

httpServer.listen(PORT, () => {
  console.log(`TuneSync server running on port ${PORT}`);
});
