const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isPrivateIpv4,
  listLanIpv4Addresses,
  startupNetworkMessages,
} = require('../src/network-addresses');

const interfaces = {
  'Loopback Pseudo-Interface 1': [
    { address: '127.0.0.1', family: 'IPv4', internal: true },
  ],
  WiFi: [
    { address: '192.168.50.12', family: 'IPv4', internal: false },
    { address: 'fe80::1', family: 'IPv6', internal: false },
  ],
  Ethernet: [
    { address: '10.20.30.40', family: 4, internal: false },
    { address: '203.0.113.10', family: 'IPv4', internal: false },
  ],
  'vEthernet (WSL)': [
    { address: '172.24.16.1', family: 'IPv4', internal: false },
  ],
  CloudflareWARP: [
    { address: '172.16.0.2', family: 'IPv4', internal: false },
  ],
};

test('RFC1918地址边界识别准确', () => {
  for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1']) {
    assert.equal(isPrivateIpv4(address), true, address);
  }
  for (const address of ['127.0.0.1', '172.15.0.1', '172.32.0.1', '203.0.113.10', '::1']) {
    assert.equal(isPrivateIpv4(address), false, address);
  }
});

test('列出全部非回环非虚拟RFC1918 IPv4地址', () => {
  assert.deepEqual(listLanIpv4Addresses(interfaces), [
    { interfaceName: 'Ethernet', address: '10.20.30.40' },
    { interfaceName: 'WiFi', address: '192.168.50.12' },
  ]);
});

test('只有监听全部接口时才把候选地址标为可访问', () => {
  assert.deepEqual(startupNetworkMessages({ host: '0.0.0.0', port: 3001 }, interfaces), [
    '本机访问地址：http://127.0.0.1:3001',
    '局域网访问地址（Ethernet）：http://10.20.30.40:3001',
    '局域网访问地址（WiFi）：http://192.168.50.12:3001',
  ]);

  const loopbackMessages = startupNetworkMessages({ host: '127.0.0.1', port: 3001 }, interfaces);
  assert.match(loopbackMessages[1], /局域网访问未启用/);
  assert.match(loopbackMessages[2], /^检测到局域网地址/);
});
