import http from 'node:http';
import { readFile } from 'node:fs/promises';

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/game.js': ['game.js', 'text/javascript; charset=utf-8'],
};
const port = Number(process.env.PORT || 4192);
http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const file = files[pathname];
  if (!file) { response.writeHead(404).end('Not found'); return; }
  try {
    const data = await readFile(new URL(file[0], import.meta.url));
    response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' }).end(data);
  } catch { response.writeHead(500).end('Could not load the prototype'); }
}).listen(port, '127.0.0.1', () => console.log(`Кубик по сетке: http://127.0.0.1:${port}`));
