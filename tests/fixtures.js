'use strict';
// Fixtures built around fake values. Every secret is passed in; the rest are
// public-looking values that a strict mask may also hide (false positives).
const crypto = require('crypto');

const hex = (n) => crypto.randomBytes(n).toString('hex');
const b64 = (n) => crypto.randomBytes(n).toString('base64');
// Never starts with `-`: a fake value that looks like a flag is not masked as a value.
const b64url = (n) => crypto.randomBytes(n).toString('base64url').replace(/^-/, 'x');

// `docker inspect` of a Redis container: password in the healthcheck and the command.
function redisInspect(pw) {
  return [{
    Id: hex(32),
    Path: 'docker-entrypoint.sh',
    Args: ['redis-server', '--requirepass', pw],
    Config: {
      Cmd: ['redis-server', '--requirepass', pw],
      Healthcheck: { Test: ['CMD', 'redis-cli', '-a', pw, 'ping'], Interval: 5000000000 },
      Image: 'redis:7-alpine',
    },
  }];
}

// A fuller `docker inspect` of an app container. Returns {json, secrets}.
function appInspect() {
  // label has a digit: rule (d) masks a long word only with one (the README says so).
  const s = { db: b64url(18), api: `sk_live_${b64url(24).replace(/[-_]/g, 'x')}`, redis: hex(16), session: b64(30), label: `${b64url(24)}0`, cmdTok: b64url(20) };
  const id = hex(32);
  const obj = [{
    Id: id,
    Created: '2026-11-11T09:14:03.123456789Z',
    Path: '/usr/local/bin/docker-entrypoint.sh',
    Args: ['node', 'server.js', '--port', '3000', '--session-secret', s.session],
    State: { Status: 'running', Running: true, Pid: 4242, StartedAt: '2026-11-11T09:14:04.000000001Z' },
    Image: `sha256:${hex(32)}`,
    Name: '/versa-app-1',
    HostConfig: { NetworkMode: 'versa_default', RestartPolicy: { Name: 'unless-stopped' }, Binds: ['/srv/versa/data:/data:rw'] },
    Mounts: [{ Type: 'volume', Name: 'versa_data', Source: '/var/lib/docker/volumes/versa_data/_data', Destination: '/data', Mode: 'z', RW: true }],
    Config: {
      Hostname: hex(6),
      User: 'node',
      Env: [`DATABASE_URL=postgres://app:${s.db}@db:5432/app`, `STRIPE_KEY=${s.api}`, 'NODE_ENV=production', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'TZ=Europe/Berlin'],
      Cmd: ['node', 'server.js', '--token', s.cmdTok],
      Healthcheck: { Test: ['CMD-SHELL', `redis-cli -a ${s.redis} ping || exit 1`], Interval: 10000000000 },
      Image: 'ghcr.io/versa-training/app:2026.11.1@sha256:' + hex(32),
      Entrypoint: ['docker-entrypoint.sh'],
      Labels: { 'com.docker.compose.project': 'versa', 'com.docker.compose.service': 'app', 'org.opencontainers.image.source': 'https://github.com/versa-training/app', 'deploy.signature': s.label },
    },
    NetworkSettings: { Networks: { versa_default: { IPAddress: '172.18.0.4', Gateway: '172.18.0.1', MacAddress: '02:42:ac:12:00:04', NetworkID: hex(32), EndpointID: hex(32) } } },
  }];
  return { json: JSON.stringify(obj, null, 4), compact: JSON.stringify(obj), secrets: Object.values(s) };
}

// `env` output.
function envOutput() {
  const s = { tok: b64url(24), pw: b64url(12), aws: b64(30) };
  const text = [
    'SHELL=/bin/bash', 'HOME=/home/dev', 'LANG=C.UTF-8', 'TERM=xterm-256color', 'USER=dev', 'PWD=/home/dev/app',
    'PATH=/home/dev/.local/bin:/usr/local/bin:/usr/bin:/bin',
    `GITHUB_TOKEN=${s.tok}`, `DB_PASS=${s.pw}`, `AWS_SECRET_ACCESS_KEY=${s.aws}`, 'EDITOR=vim', 'SHLVL=1',
  ].join('\n') + '\n';
  return { text, secrets: Object.values(s) };
}

// `kubectl get secret -o yaml`.
function kubeSecret() {
  const s = { user: Buffer.from('svc-' + hex(4)).toString('base64'), pw: b64(24), cert: b64(40) };
  const text = `apiVersion: v1
data:
  username: ${s.user}
  password: ${s.pw}
  tls.crt: ${s.cert}
kind: Secret
metadata:
  creationTimestamp: "2026-11-01T10:00:00Z"
  name: db-credentials
  namespace: versa
  resourceVersion: "123456"
  uid: 6f1c2d3e-4b5a-6978-8a9b-0c1d2e3f4a5b
type: Opaque
`;
  return { text, secrets: Object.values(s) };
}

// `docker compose config`.
function composeConfig() {
  const s = { redis: b64url(18), pg: b64url(15), jwt: b64url(30), hc: hex(12) };
  const text = `name: versa
services:
  app:
    build:
      context: /srv/versa
      dockerfile: Dockerfile
    environment:
      DATABASE_URL: postgres://app:${s.pg}@db:5432/app
      JWT_SECRET: ${s.jwt}
      NODE_ENV: production
      LOG_LEVEL: info
    image: ghcr.io/versa-training/app:latest
    ports:
      - mode: ingress
        target: 3000
        published: "3000"
        protocol: tcp
  redis:
    command:
      - redis-server
      - --requirepass
      - ${s.redis}
    healthcheck:
      test:
        - CMD
        - redis-cli
        - -a
        - ${s.hc}
        - ping
      interval: 5s
    image: redis:7-alpine
networks:
  default:
    name: versa_default
`;
  return { text, secrets: Object.values(s) };
}

module.exports = { redisInspect, appInspect, envOutput, kubeSecret, composeConfig, hex };
