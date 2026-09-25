'use strict';

const crypto = require('crypto');

// Пароли хешируются встроенным crypto.scryptSync — без внешних native-модулей.
// Формат хранения самодостаточен (параметры стойкости лежат в самом хеше):
//   scrypt$N$r$p$saltHex$keyHex
// N — множитель стоимости, r — блоковый размер, p — распараллеливание,
// salt — уникальная соль для каждого пароля (16 байт).
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
const PREFIX = 'scrypt';

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = crypto.scryptSync(String(password), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('hex'), key.toString('hex')].join('$');
}

function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;
  const [, n, r, p, saltHex, keyHex] = parts;
  const N = Number(n);
  const R = Number(r);
  const P = Number(p);
  if (!Number.isInteger(N) || !Number.isInteger(R) || !Number.isInteger(P)) return false;
  const expected = Buffer.from(keyHex, 'hex');
  if (expected.length === 0) return false;
  let computed;
  try {
    computed = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length, {
      N,
      r: R,
      p: P,
      maxmem: 64 * 1024 * 1024,
    });
  } catch (err) {
    return false;
  }
  return computed.length === expected.length && crypto.timingSafeEqual(computed, expected);
}

// «Фоновый» хеш для выравнивания времени ответа при входе: когда логина
// не существует, всё равно вычисляется scrypt этой «пустышки», чтобы по
// длительности ответа нельзя было отличить «нет такого логина» от «неверный
// пароль». Совпадение с константным нулевым ключом невозможно.
const DUMMY_HASH = [PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, '0'.repeat(SALT_LEN * 2), '0'.repeat(KEY_LEN * 2)].join('$');

module.exports = { hashPassword, verifyPassword, DUMMY_HASH };