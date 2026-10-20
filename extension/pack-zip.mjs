/**
 * 极简 ZIP 打包工具（store 模式、纯 Node、零依赖）。
 *
 * 用于构建后把 dist 打包为可分发的 zip，避免依赖系统 zip 命令
 * （部分环境未安装）。store 模式不压缩，dist 本身体积很小，足够使用。
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative, sep } from 'path';

// CRC32 查表（ZIP 规范要求每个文件记录 CRC32 校验）
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/**
 * 计算缓冲区的 CRC32 校验值。
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 递归收集目录下全部文件（zip 内路径统一使用 / 分隔）。
 */
function collectFiles(dir, baseDir = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectFiles(full, baseDir, out);
    } else {
      out.push({ full, rel: relative(baseDir, full).split(sep).join('/') });
    }
  }
  return out;
}

/**
 * 把目录打包为 zip 文件。
 *
 * @param srcDir 源目录（其内容为 zip 根）
 * @param outFile 输出 zip 路径
 * @returns 打包的文件数
 */
export function packZip(srcDir, outFile) {
  const files = collectFiles(srcDir);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { full, rel } of files) {
    const data = readFileSync(full);
    const nameBuf = Buffer.from(rel, 'utf8');
    const crc = crc32(data);

    // 本地文件头：签名 / 版本 / UTF-8 标志 / store / CRC / 大小 / 文件名长度
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 解压所需最低版本
    local.writeUInt16LE(0x0800, 6); // 标志位：文件名为 UTF-8
    local.writeUInt16LE(0, 8); // 压缩方式 0 = store
    local.writeUInt16LE(0, 10); // DOS 修改时间
    local.writeUInt16LE(0, 12); // DOS 修改日期
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // 压缩后大小
    local.writeUInt32LE(data.length, 22); // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    localParts.push(local, nameBuf, data);

    // 中央目录项（偏移指向本地文件头起始位置）
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // 制作版本
    central.writeUInt16LE(20, 6); // 解压版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // 本地头偏移
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centralParts);

  // 目录结束记录（EOCD）
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); // 条目数
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16); // 中央目录起始偏移

  writeFileSync(outFile, Buffer.concat([...localParts, centralBuf, eocd]));
  return files.length;
}
