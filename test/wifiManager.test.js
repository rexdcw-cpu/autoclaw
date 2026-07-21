'use strict';

const assert = require('assert');
const test = require('node:test');
const wifi = require('../core/wifiManager');

// 模拟中文 Windows 下 netsh 的真实输出（节选）
const SAMPLE = `
接口名称 : WLAN
当前有 2 个网络可见。

SSID 1 : SCWL_5G
    Network type            : 结构
    身份验证                : WPA2 - 个人
    加密                    : CCMP
    BSSID 1                 : 44:df:65:d7:e2:45
         信号             : 78%
         无线电类型         : 802.11ax
         频道            : 36

SSID 2 : FreeNet
    Network type            : 结构
    身份验证                : 开放式
    加密                    : 无
    BSSID 1                 : aa:bb:cc:dd:ee:ff
         信号             : 50%
         无线电类型         : 802.11n
`;

const SAMPLE_EN = `
There are 2 networks currently visible.

SSID 1 : OfficeWiFi
    Authentication          : WPA2-Personal
    Encryption              : CCMP
    Signal                  : 88%
`;

test('parseNetworks 解析中文 netsh 输出', () => {
  const nets = wifi.parseNetworks(SAMPLE);
  assert.ok(nets.length >= 2);
  const scwl = nets.find((n) => n.ssid === 'SCWL_5G');
  assert.ok(scwl, '应能解析出 SCWL_5G');
  assert.strictEqual(scwl.auth, 'WPA2 - 个人');
  assert.strictEqual(scwl.enc, 'CCMP');
  assert.strictEqual(scwl.signal, 78);
  const free = nets.find((n) => n.ssid === 'FreeNet');
  assert.ok(free, '应能解析出 FreeNet');
  assert.strictEqual(free.auth, '开放式');
  // 回归：BSSID 行里的 "SSID" 不得被误切成独立网络（旧实现会把
  // "Network type : Infrastructure" 之类的行当 SSID）
  const garbage = nets.filter((n) => /[:]/.test(n.ssid) || n.ssid.includes('Network type'));
  assert.strictEqual(garbage.length, 0, '不应出现冒号/Network type 之类的垃圾 SSID');
});

test('parseNetworks 解析英文 netsh 输出', () => {
  const nets = wifi.parseNetworks(SAMPLE_EN);
  const o = nets.find((n) => n.ssid === 'OfficeWiFi');
  assert.ok(o);
  assert.strictEqual(o.auth, 'WPA2-Personal');
  assert.strictEqual(o.signal, 88);
});

test('parseNetworks 同名 SSID 去重（取信号最强）', () => {
  const dup = `
SSID 1 : Same
    身份验证 : WPA2 - 个人
    加密 : CCMP
    信号 : 40%
SSID 2 : Same
    身份验证 : WPA2 - 个人
    加密 : CCMP
    信号 : 90%
`;
  const nets = wifi.parseNetworks(dup);
  assert.strictEqual(nets.length, 1);
  assert.strictEqual(nets[0].signal, 90);
});

test('normalizeSecurity: WPA2 个人 → WPA2PSK/AES', () => {
  assert.deepStrictEqual(wifi.normalizeSecurity('WPA2 - 个人', 'CCMP'), {
    authentication: 'WPA2PSK',
    encryption: 'AES',
  });
});

test('normalizeSecurity: WPA 个人 → WPAPSK', () => {
  assert.deepStrictEqual(wifi.normalizeSecurity('WPA - 个人', 'TKIP'), {
    authentication: 'WPAPSK',
    encryption: 'TKIP',
  });
});

test('normalizeSecurity: WPA3 个人 → WPA3SAE/AES', () => {
  assert.deepStrictEqual(wifi.normalizeSecurity('WPA3 - 个人', 'CCMP'), {
    authentication: 'WPA3SAE',
    encryption: 'AES',
  });
});

test('normalizeSecurity: 开放网络 → open/none', () => {
  assert.deepStrictEqual(wifi.normalizeSecurity('开放式', '无'), {
    authentication: 'open',
    encryption: 'none',
  });
  assert.deepStrictEqual(wifi.normalizeSecurity('Open', 'none'), {
    authentication: 'open',
    encryption: 'none',
  });
});

test('normalizeSecurity: 企业网络 → null', () => {
  assert.strictEqual(wifi.normalizeSecurity('WPA2 - 企业', 'CCMP'), null);
  assert.strictEqual(wifi.normalizeSecurity('WPA2-Enterprise', 'AES'), null);
});

test('buildProfileXml: WPA2 生成合法片段', () => {
  const xml = wifi.buildProfileXml('MyWiFi', 'WPA2PSK', 'AES', 'secret123');
  assert.ok(xml.includes('<authentication>WPA2PSK</authentication>'));
  assert.ok(xml.includes('<encryption>AES</encryption>'));
  assert.ok(xml.includes('<keyMaterial>secret123</keyMaterial>'));
});

test('buildProfileXml: 开放网络无 sharedKey', () => {
  const xml = wifi.buildProfileXml('Free', 'open', 'none', '');
  assert.ok(xml.includes('<authentication>open</authentication>'));
  assert.ok(!xml.includes('sharedKey'));
});

test('buildProfileXml: 对 SSID/密码做 XML 转义', () => {
  const xml = wifi.buildProfileXml('A&B<C', 'WPA2PSK', 'AES', 'p&w"x');
  assert.ok(xml.includes('<name>A&amp;B&lt;C</name>'));
  assert.ok(xml.includes('<keyMaterial>p&amp;w&quot;x</keyMaterial>'));
});
