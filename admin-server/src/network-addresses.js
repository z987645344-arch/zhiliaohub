const net = require('node:net');
const os = require('node:os');

const VIRTUAL_INTERFACE_PATTERN =
  /(?:^lo$|loopback|virtual|vmware|vbox|virtualbox|hyper-v|vethernet|wsl|docker|container|tap|tun|vpn|anyconnect|cloudflare|warp|tailscale|zerotier|hamachi)/i;

function isPrivateIpv4(address) {
  if (!net.isIPv4(address)) return false;
  const octets = address.split('.').map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function isVirtualInterface(name) {
  return VIRTUAL_INTERFACE_PATTERN.test(name);
}

function listLanIpv4Addresses(networkInterfaces = os.networkInterfaces()) {
  const seen = new Set();
  const addresses = [];
  for (const [interfaceName, entries] of Object.entries(networkInterfaces)) {
    if (isVirtualInterface(interfaceName)) continue;
    for (const entry of entries || []) {
      const isIpv4 = entry.family === 'IPv4' || entry.family === 4;
      if (!isIpv4 || entry.internal || !isPrivateIpv4(entry.address) || seen.has(entry.address)) {
        continue;
      }
      seen.add(entry.address);
      addresses.push({ interfaceName, address: entry.address });
    }
  }
  return addresses.sort((first, second) =>
    first.interfaceName.localeCompare(second.interfaceName, 'zh-CN')
      || first.address.localeCompare(second.address, 'en'),
  );
}

function startupNetworkMessages(config, networkInterfaces = os.networkInterfaces()) {
  const candidates = listLanIpv4Addresses(networkInterfaces);
  const wildcardHost = config.host === '0.0.0.0' || config.host === '::';
  const loopbackHost = config.host === 'localhost'
    || config.host === '::1'
    || config.host.startsWith('127.');

  if (wildcardHost) {
    const messages = [`本机访问地址：http://127.0.0.1:${config.port}`];
    if (candidates.length === 0) {
      messages.push('未检测到可用的非虚拟 RFC1918 IPv4 局域网地址。');
    } else {
      messages.push(...candidates.map(({ interfaceName, address }) =>
        `局域网访问地址（${interfaceName}）：http://${address}:${config.port}`,
      ));
    }
    return messages;
  }

  if (loopbackHost) {
    const messages = [`本机访问地址：http://${config.host}:${config.port}`];
    messages.push(`局域网访问未启用：当前仅监听 ${config.host}；需要时请将 HOST 改为 0.0.0.0。`);
    messages.push(...candidates.map(({ interfaceName, address }) =>
      `检测到局域网地址（${interfaceName}）：http://${address}:${config.port}`,
    ));
    return messages;
  }

  return [`监听地址：http://${config.host}:${config.port}`];
}

module.exports = {
  isPrivateIpv4,
  isVirtualInterface,
  listLanIpv4Addresses,
  startupNetworkMessages,
};
