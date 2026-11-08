/* Shared, testable Web Bluetooth codec and transaction queue.
   Settings format 4 (firmware up to 18.1) and 5 (18.2+: head tracking, per-host profiles). */
(function (root) {
  'use strict';
  const LAYOUTS = {
    4: [['magic',0,'u8'],['version',1,'u8'],['invert',2,'u8'],['holdMode',3,'u8'],
        ['maxStep',4,'u16'],['idleMinutes',6,'u16'],['yawSensitivity',8,'f32'],['pitchSensitivity',12,'f32'],
        ['exponent',16,'f32'],['minCutoff',20,'f32'],['beta',24,'f32'],
        ['yawDeadzone',28,'f32'],['pitchDeadzone',32,'f32'],['outputDeadzone',36,'f32']],
    5: [['magic',0,'u8'],['version',1,'u8'],['invert',2,'u8'],['profile',3,'u8'],
        ['maxStep',4,'u16'],['reserved',6,'u16'],['slowGainX',8,'f32'],['slowGainY',12,'f32'],
        ['fastGainX',16,'f32'],['fastGainY',20,'f32'],['slowSpeed',24,'f32'],['fastSpeed',28,'f32'],
        ['minCutoff',32,'f32'],['beta',36,'f32']]
  };
  const RANGES = {
    4: {yawSensitivity:[0,100],pitchSensitivity:[0,100],exponent:[.1,2],minCutoff:[.01,50],beta:[0,10],
        yawDeadzone:[0,1],pitchDeadzone:[0,1],outputDeadzone:[0,1],maxStep:[1,127],holdMode:[0,1],idleMinutes:[0,1440]},
    5: {slowGainX:[0,400],slowGainY:[0,400],fastGainX:[0,600],fastGainY:[0,600],slowSpeed:[0,60],fastSpeed:[1,200],
        minCutoff:[.05,20],beta:[0,1],maxStep:[1,127],profile:[0,255],reserved:[0,65535]}
  };
  const INTS = {4: ['maxStep','holdMode','idleMinutes'], 5: ['maxStep','profile','reserved']};
  function validate(o) {
    if (!o || o.magic !== 0x4D || !LAYOUTS[o.version] || !Number.isInteger(o.invert) || o.invert < 0 || o.invert > 3)
      throw new Error('Неизвестный формат настроек');
    const ranges = RANGES[o.version];
    Object.keys(ranges).forEach(k => {
      if (!Number.isFinite(o[k]) || o[k] < ranges[k][0]-1e-7 || o[k] > ranges[k][1]+1e-7)
        throw new Error('Недопустимое значение: ' + k);
    });
    if (!INTS[o.version].every(k => Number.isInteger(o[k]))) throw new Error('Шаг должен быть целым числом');
    return o;
  }
  function decode(dv) {
    if (dv.byteLength !== 40) throw new Error('Ожидалось 40 байт настроек');
    const layout = LAYOUTS[dv.getUint8(1)];
    if (!layout) throw new Error('Неизвестный формат настроек ' + dv.getUint8(1));
    const o = {};
    layout.forEach(([k,n,t]) => { o[k] = t === 'u8' ? dv.getUint8(n) : t === 'u16' ? dv.getUint16(n,true) : dv.getFloat32(n,true); });
    return validate(o);
  }
  function encode(o) {
    validate(o);
    const buffer = new ArrayBuffer(40), dv = new DataView(buffer);
    LAYOUTS[o.version].forEach(([k,n,t]) => {
      if (t === 'u8') dv.setUint8(n,o[k]);
      else if (t === 'u16') dv.setUint16(n,o[k],true);
      else dv.setFloat32(n,o[k],true);
    });
    return buffer;
  }
  // Fields the firmware owns (profile slot) are left out of the "did it apply" check.
  function comparable(o) { const c = Object.assign({}, o); if (c.version === 5) c.profile = 0; return encode(c); }
  function equal(a,b) { return a.byteLength === b.byteLength && new Uint8Array(a).every((v,i) => v === new Uint8Array(b)[i]); }
  class Session {
    constructor(cfg,cmd) { this.cfg = cfg; this.cmd = cmd; this.active = true; this.tail = Promise.resolve(); }
    close() { this.active = false; }
    check() { if (!this.active) throw new Error('Подключение устарело; подключитесь снова'); }
    enqueue(fn) {
      const result = this.tail.then(() => { this.check(); return fn(); });
      this.tail = result.catch(() => {});
      return result;
    }
    async put(char,data) {
      this.check();
      if (char.writeValueWithResponse) await char.writeValueWithResponse(data);
      else await char.writeValue(data);
      this.check();
    }
    async readNow() {
      this.check();
      const raw = await this.cfg.readValue();
      this.check();
      return decode(raw);
    }
    async writeNow(o) {
      o = Object.assign({}, o);
      if (o.version === 4) o.idleMinutes = 7;
      if (o.version === 5) o.reserved = 0;
      await this.put(this.cfg,encode(o));
      const actual = await this.readNow();
      if (!equal(comparable(actual),comparable(o))) throw new Error('Устройство не применило эти значения; переподключитесь');
      return actual;
    }
    async commandNow(byte) {
      await this.put(this.cmd,new Uint8Array([byte]));
      if (!this.cmd.properties.read) return false;
      for (let i=0;i<200;i++) {   // two files are written since 17.6: give flash ~10 s
        this.check();
        const status = await this.cmd.readValue();
        this.check();
        if (status.byteLength === 1 && status.getUint8(0) === (0x80|byte)) return true;
        if (status.byteLength && status.getUint8(0) >= 0xE0) throw new Error('Устройство сообщило об ошибке сохранения/команды');
        await new Promise(resolve => setTimeout(resolve,50));
      }
      throw new Error('Нет подтверждения выполнения команды');
    }
    read() { return this.enqueue(() => this.readNow()); }
    write(o) { const snapshot = Object.assign({},o); return this.enqueue(() => this.writeNow(snapshot)); }
    save(o) {
      const snapshot = Object.assign({},o);
      return this.enqueue(async () => { await this.writeNow(snapshot); return this.commandNow(1); });
    }
    defaults() { return this.enqueue(async () => { await this.commandNow(2); return this.readNow(); }); }
  }
  const api = {validate,decode,encode,Session,LAYOUTS,RANGES};
  root.UmitProtocol = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
