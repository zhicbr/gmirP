/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

// 配置
const CONFIG = {
  HTTP_PORT: 8889,
  WS_PORT: 9998,
  TARGET_DOMAIN: 'generativelanguage.googleapis.com'
};

// 日志工具
const Logger = {
  log(...args) {
    const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
    console.log(`[${timestamp}]`, ...args);
  },
  
  error(...args) {
    const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
    console.error(`[${timestamp}] ❌`, ...args);
  },
  
  success(...args) {
    const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
    console.log(`[${timestamp}] ✅`, ...args);
  }
};

// HTTP 服务器
class HTTPServer {
  constructor(proxyManager) {
    this.app = express();
    this.proxyManager = proxyManager;
    this.setupMiddleware();
    this.setupRoutes();
  }
  
  setupMiddleware() {
    // 解析 JSON body
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.text({ type: 'text/plain', limit: '50mb' }));
    
    // CORS 支持
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });
    
    // 请求日志
    this.app.use((req, res, next) => {
      Logger.log(`📨 HTTP请求: ${req.method} ${req.path}`);
      next();
    });
  }
  
  setupRoutes() {
    // 健康检查
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        browserConnected: this.proxyManager.isConnected(),
        timestamp: new Date().toISOString()
      });
    });
    
    // 代理所有请求 - 使用中间件方式
    this.app.use(async (req, res, next) => {
      // 跳过 /health 路径
      if (req.path === '/health') {
        return next();
      }
      
      try {
        await this.proxyManager.forwardRequest(req, res);
      } catch (error) {
        Logger.error('请求处理失败:', error.message);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Proxy error',
            message: error.message
          });
        }
      }
    });
  }
  
  start() {
    return new Promise((resolve) => {
      this.server = this.app.listen(CONFIG.HTTP_PORT, () => {
        Logger.success(`HTTP服务启动成功: http://127.0.0.1:${CONFIG.HTTP_PORT}`);
        resolve();
      });
    });
  }
}

// WebSocket 代理管理器
class ProxyManager {
  constructor() {
    this.browserClient = null;
    this.pendingRequests = new Map();
    this.requestIdCounter = 0;
  }
  
  isConnected() {
    return this.browserClient !== null && this.browserClient.readyState === 1; // OPEN
  }
  
  setupWebSocket() {
    this.wss = new WebSocketServer({ port: CONFIG.WS_PORT });
    
    this.wss.on('connection', (ws) => {
      Logger.success('🔗 浏览器客户端已连接');
      
      this.browserClient = ws;
      
      ws.on('message', (data) => {
        this.handleBrowserMessage(data);
      });
      
      ws.on('close', () => {
        Logger.log('❌ 浏览器客户端断开连接');
        this.browserClient = null;
        
        // 清理所有待处理的请求
        this.pendingRequests.forEach((pending) => {
          if (!pending.res.headersSent) {
            pending.res.status(502).json({
              error: 'Browser disconnected'
            });
          }
        });
        this.pendingRequests.clear();
      });
      
      ws.on('error', (error) => {
        Logger.error('WebSocket错误:', error.message);
      });
    });
    
    Logger.success(`WebSocket服务启动成功: ws://127.0.0.1:${CONFIG.WS_PORT}`);
  }
  
  async forwardRequest(req, res) {
    if (!this.isConnected()) {
      return res.status(503).json({
        error: 'Browser not connected',
        message: '浏览器代理未连接，请在浏览器控制台执行 dark-browser.js'
      });
    }
    
    const requestId = `req_${++this.requestIdCounter}_${Date.now()}`;
    
    // 构建请求规范
    const requestSpec = {
      request_id: requestId,
      method: req.method,
      path: req.path,
      query_params: req.query,
      headers: this.sanitizeHeaders(req.headers),
      body: req.body ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : undefined
    };
    
    Logger.log(`📤 转发请求到浏览器: ${requestId}`);
    
    // 发送到浏览器
    this.browserClient.send(JSON.stringify(requestSpec));
    
    // 存储响应对象
    this.pendingRequests.set(requestId, {
      res,
      headersSent: false,
      timeout: setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          if (!res.headersSent) {
            res.status(504).json({
              error: 'Request timeout',
              request_id: requestId
            });
          }
        }
      }, 120000) // 120秒超时
    });
  }
  
  handleBrowserMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      const requestId = message.request_id;
      
      if (!requestId || !this.pendingRequests.has(requestId)) {
        Logger.error('收到未知请求ID的响应:', requestId);
        return;
      }
      
      const pending = this.pendingRequests.get(requestId);
      
      switch (message.event_type) {
        case 'response_headers':
          this.handleResponseHeaders(message, pending);
          break;
          
        case 'chunk':
          this.handleChunk(message, pending);
          break;
          
        case 'stream_close':
          this.handleStreamClose(message, pending);
          break;
          
        case 'error':
          this.handleError(message, pending);
          break;
          
        default:
          Logger.log('未知事件类型:', message.event_type);
      }
    } catch (error) {
      Logger.error('处理浏览器消息失败:', error.message);
    }
  }
  
  handleResponseHeaders(message, pending) {
    if (pending.headersSent) return;
    
    // 设置状态码
    pending.res.status(message.status);
    
    // 设置响应头
    if (message.headers) {
      Object.entries(message.headers).forEach(([key, value]) => {
        // 跳过一些不应该转发的头
        const lowerKey = key.toLowerCase();
        if (!['transfer-encoding', 'content-encoding', 'content-length'].includes(lowerKey)) {
          pending.res.setHeader(key, value);
        }
      });
    }
    
    pending.headersSent = true;
    Logger.log(`📥 响应头已接收: ${message.request_id} (状态: ${message.status})`);
  }
  
  handleChunk(message, pending) {
    if (!pending.headersSent) {
      // 如果还没发送头，先发送默认头
      pending.res.status(200);
      pending.headersSent = true;
    }
    
    // 写入数据块
    pending.res.write(message.data);
  }
  
  handleStreamClose(message, pending) {
    Logger.success(`✅ 请求完成: ${message.request_id}`);
    
    // 清理超时定时器
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    
    // 结束响应
    if (!pending.res.headersSent) {
      pending.res.status(200);
    }
    pending.res.end();
    
    // 清理待处理请求
    this.pendingRequests.delete(message.request_id);
  }
  
  handleError(message, pending) {
    Logger.error(`请求错误: ${message.request_id}`, message.message);
    
    // 清理超时定时器
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    
    // 发送错误响应
    if (!pending.res.headersSent) {
      pending.res.status(message.status || 500).json({
        error: 'Proxy error',
        message: message.message,
        request_id: message.request_id
      });
    } else {
      pending.res.end();
    }
    
    // 清理待处理请求
    this.pendingRequests.delete(message.request_id);
  }
  
  sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    
    // 删除不应该转发的头
    delete sanitized.host;
    delete sanitized.connection;
    delete sanitized['content-length'];
    
    return sanitized;
  }
}

// 主函数
async function main() {
  console.log('\n==============================================');
  console.log('🚀 Google AI Studio 代理服务器');
  console.log('==============================================\n');
  
  try {
    const proxyManager = new ProxyManager();
    const httpServer = new HTTPServer(proxyManager);
    
    // 启动 WebSocket 服务
    proxyManager.setupWebSocket();
    
    // 启动 HTTP 服务
    await httpServer.start();
    
    console.log('\n==============================================');
    Logger.success('所有服务启动完成！');
    console.log('==============================================\n');
    console.log('📝 使用说明:');
    console.log('1. 在浏览器中打开 AI Studio 并登录');
    console.log('2. 按 F12 打开开发者工具');
    console.log('3. 在控制台执行 dark-browser.js 代码');
    console.log('4. 看到 "浏览器代理系统已成功启动" 后即可使用');
    console.log('\n💡 测试命令:');
    console.log(`   GET  http://127.0.0.1:${CONFIG.HTTP_PORT}/v1beta/models`);
    console.log(`   POST http://127.0.0.1:${CONFIG.HTTP_PORT}/v1beta/models/gemini-pro:generateContent`);
    console.log('\n按 Ctrl+C 停止服务器\n');
    
  } catch (error) {
    Logger.error('服务器启动失败:', error);
    process.exit(1);
  }
}

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n\n👋 正在关闭服务器...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n👋 正在关闭服务器...');
  process.exit(0);
});

// 启动
main();