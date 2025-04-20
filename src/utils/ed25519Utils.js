/**
 * ED25519签名工具类
 * 用于Backpack交易所API请求认证
 */

const crypto = require('crypto');
const nacl = require('tweetnacl');
const base64 = require('base64-js');

/**
 * 生成ED25519签名
 */
class ED25519Signer {
  /**
   * 构造函数
   * @param {string} apiSecret - Base64格式的API密钥
   */
  constructor(apiSecret) {
    // 解码API密钥
    this.apiSecretBytes = Buffer.from(apiSecret, 'base64');
    
    // 如果密钥长度不是32字节，使用SHA256处理
    if (this.apiSecretBytes.length !== 32) {
      this.apiSecretBytes = crypto.createHash('sha256').update(this.apiSecretBytes).digest();
    }
    
    // 创建签名密钥
    this.signingKey = nacl.sign.keyPair.fromSeed(this.apiSecretBytes).secretKey;
  }
  
  /**
   * 生成API请求签名
   * @param {Object} signatureData - 包含指令类型、参数、数据和时间戳等的数据对象
   * @returns {string} Base64编码的签名
   */
  generateSignature(signatureData) {
    try {
      // 验证入参
      if (!signatureData) {
        throw new Error('签名数据不能为空');
      }
      
      // 从签名数据中提取必要参数
      const { instructionType, params = {}, payload = null, timestamp, window } = signatureData;
      
      // 验证必要参数
      if (!instructionType) {
        throw new Error('指令类型不能为空');
      }
      
      if (timestamp === undefined || timestamp === null) {
        throw new Error('时间戳不能为空');
      }
      
      if (window === undefined || window === null) {
        throw new Error('窗口值不能为空');
      }
      
      // 根据文档构建签名字符串
      let signatureString = `instruction=${instructionType}`;
      
      // 添加查询参数 - 按字母顺序排序
      if (params && Object.keys(params).length > 0) {
        const sortedKeys = Object.keys(params).sort();
        for (const key of sortedKeys) {
          if (params[key] !== null && params[key] !== undefined) {
            signatureString += `&${key}=${params[key]}`;
          }
        }
      }
      
      // 处理payload
      if (payload !== null && payload !== undefined) {
        if (typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length > 0) {
          // 对象形式的payload，按字母顺序排序键并添加到查询字符串
          const sortedKeys = Object.keys(payload).sort();
          for (const key of sortedKeys) {
            if (payload[key] !== null && payload[key] !== undefined) {
              signatureString += `&${key}=${payload[key]}`;
            }
          }
        }
      }
      
      // 添加时间戳和窗口
      signatureString += `&timestamp=${timestamp}&window=${window}`;
      
      console.log(`签名字符串: ${signatureString}`);
      
      // 使用ED25519算法签名
      const messageBytes = Buffer.from(signatureString, 'utf8');
      const signatureBytes = nacl.sign.detached(messageBytes, this.signingKey);
      
      // 返回Base64编码的签名
      return Buffer.from(signatureBytes).toString('base64');
    } catch (error) {
      console.error(`ED25519签名生成错误: ${error.message}`);
      console.error(`错误堆栈: ${error.stack}`);
      throw error;
    }
  }
}

module.exports = ED25519Signer; 