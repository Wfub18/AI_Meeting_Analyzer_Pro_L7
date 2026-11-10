import { lookup } from 'node:dns';
import { get } from 'node:https';
import { BlockList, isIPv4 } from 'node:net';
import { Readable } from 'node:stream';

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) {
  blocked.addSubnet(network, prefix);
}

export function publicLookup(hostname, options, callback, resolve = lookup) {
  resolve(hostname, { all: true, family: 4 }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => !isIPv4(address) || blocked.check(address))) {
      return callback(Object.assign(new Error('Non-public destination'), { code: 'UNSAFE_DNS' }));
    }
    // The socket uses this checked address directly and TLS still authenticates the original host.
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, 4);
  });
}

export function requestHttps(url, { signal }) {
  return new Promise((resolve, reject) => {
    const request = get(url, {
      agent: false, family: 4, autoSelectFamily: false, lookup: publicLookup,
      rejectUnauthorized: true, signal, headers: { 'accept-encoding': 'identity' },
    }, response => {
      resolve({
        status: response.statusCode,
        headers: new Headers(response.headers),
        body: Readable.toWeb(response),
      });
    });
    request.once('error', reject);
  });
}
