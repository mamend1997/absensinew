import { createDecipheriv, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import 'dotenv/config';

async function main() {
  const [inputPath, outputPath] = process.argv.slice(2);
  const secret = process.env.JWT_SECRET ?? '';
  if (!inputPath || !outputPath || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Gunakan: node scripts/decrypt-platform-backup.js <file.enc> <output.json> dengan JWT_SECRET yang sama.');
  }
  const envelope = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new Error('Format backup terenkripsi tidak didukung.');
  }
  const key = createHash('sha256')
    .update('ruang-hadir-platform-backup-v1\0')
    .update(secret)
    .digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  const backup = JSON.parse(plaintext.toString('utf8'));
  if (backup.format !== 'ruang-hadir-saas-backup' || backup.version !== 1) {
    throw new Error('Isi backup platform tidak valid.');
  }
  await writeFile(resolve(outputPath), `${JSON.stringify(backup, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  console.log('Backup didekripsi. File berisi data sekolah dan hash kredensial; simpan dengan aman.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Backup platform gagal didekripsi.');
  process.exitCode = 1;
});
