import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {X509Certificate} from 'node:crypto';
import {proxyForUrl,resolveExtraCaPath} from '../../apps/tui/src/provider-transport.ts';
import {parseSystemProxyConfig} from '../../apps/tui/src/macos-system-proxy.ts';
import {trustedFingerprintsFromXml,certificatesMatchingFingerprints} from '../../apps/tui/src/macos-trusted-certificates.ts';
const cases=[];
function route(name:string,url:string,environment:Record<string,string>={},system:Record<string,string>={}){cases.push({name,url,environment,system,expected:proxyForUrl(new URL(url),environment,system)??null,extraCa:resolveExtraCaPath(environment)??null});}
for(const protocol of ['http','https']){
 const url=`${protocol}://api.example.com/v1`;
 const system={http:'http://system-http:80',https:'http://system-https:443'};
 route(`${protocol}-system`,url,{},system);
 route(`${protocol}-environment-priority`,url,{HTTP_PROXY:'http://upper-http:80',http_proxy:'http://lower-http:80',HTTPS_PROXY:'http://upper-https:80',https_proxy:'http://lower-https:80',ALL_PROXY:'http://all:80'},system);
 route(`${protocol}-lowercase`,url,{http_proxy:'http://lower-http:80',https_proxy:'http://lower-https:80'},system);
 route(`${protocol}-all`,url,{ALL_PROXY:'http://all:80'},system);
 route(`${protocol}-blank-upper`,url,{HTTP_PROXY:' ',HTTPS_PROXY:'\ufeff',ALL_PROXY:'',all_proxy:' http://lower-all:80 '},system);
 for(const noProxy of ['*','api.example.com','example.com','.example.com','*.example.com','api.example.com:80','api.example.com:443','unrelated.test,api.example.com','\ufeffapi.example.com\ufeff','\u0085api.example.com\u0085'])route(`${protocol}-no-proxy-${noProxy}`,url,{HTTPS_PROXY:'http://env:80',HTTP_PROXY:'http://env:80',NO_PROXY:noProxy},system);
}
route('lowercase-bypass','https://api.example.com',{HTTPS_PROXY:'http://env:80',NO_PROXY:' ',no_proxy:'api.example.com'});
route('upper-bypass-overrides-lower','https://api.example.com',{HTTPS_PROXY:'http://env:80',NO_PROXY:'other.test',no_proxy:'*'});
for(const rule of ['[::1]','[::1]:8080','::1','*'])route(`ipv6-${rule}`,'http://[::1]:8080',{HTTP_PROXY:'http://env:80',NO_PROXY:rule});
route('extra-ca-precedence','https://api.example.com',{PEER_EXTRA_CA_CERTS:' chosen.pem ',NODE_EXTRA_CA_CERTS:'fallback.pem'});
route('extra-ca-fallback','https://api.example.com',{PEER_EXTRA_CA_CERTS:' ',NODE_EXTRA_CA_CERTS:'fallback.pem'});
const system=['<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : 8899\n HTTPSEnable : 1\n HTTPSProxy : proxy.test\n HTTPSPort : 8080\n}', 'HTTPEnable : 0\nHTTPProxy : disabled\nSOCKSEnable : 1\nSOCKSProxy : ignored', 'HTTPEnable : 1\nHTTPProxy : host-only', 'HTTPEnable : 1\nHTTPPort : 80'].map(raw=>({raw,expected:parseSystemProxyConfig(raw)}));
const fingerprint=(pem:string)=>new X509Certificate(pem).fingerprint.replaceAll(':','').toUpperCase();
// Fixed public inputs: runtime root catalogs change across Bun versions.
// Expected values still come from the actual production TS selector.
const first=readFileSync('crates/peer-cli/tests/fixtures/network/ca.pem','utf8').trim(),second=readFileSync('crates/peer-cli/tests/fixtures/network/server.pem','utf8').trim();
const trust=[{xml:`<dict><key>${fingerprint(first)}</key><dict></dict><key>${fingerprint(second)}</key><dict><key>kSecTrustSettingsResult</key>\n<integer>3</integer></dict></dict>`,pem:`${first}\n${second}\n${first}\nnot a certificate`},{xml:'<dict/>',pem:first},{xml:`<key>${fingerprint(second).toLowerCase()}</key><dict/>`,pem:`${first}\n${second}`}].map(value=>({...value,expected:certificatesMatchingFingerprints(value.pem,trustedFingerprintsFromXml(value.xml))}));
const text=JSON.stringify({version:1,routes:cases,system,trust},null,2)+'\n';const file='packages/protocol/contracts/native-cli/network.json';
if(process.argv.includes('--write'))writeFileSync(file,text);else assert.equal(readFileSync(file,'utf8'),text,'regenerate native network contracts with actual TS');
console.log(JSON.stringify({networkRoutes:cases.length,systemCases:system.length,trustCases:trust.length}));
