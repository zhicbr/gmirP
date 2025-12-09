
// 调试输出模块
const Logger = {
  enabled: true,
  
  output(...messages) {
    if (!this.enabled) return;
    
    const timestamp = this._getTimestamp();
    const logElement = document.createElement('div');
    logElement.textContent = `[${timestamp}] ${messages.join(' ')}`;
    document.body.appendChild(logElement);
  },
  
  _getTimestamp() {
    const now = new Date();
    const time = now.toLocaleTimeString('zh-CN', { hour12: false });
    const ms = now.getMilliseconds().toString().padStart(3, '0');
    return `${time}.${ms}`;
  }
};

// WebSocket连接管理器
class ConnectionManager extends EventTarget {
  constructor(endpoint = 'ws://127.0.0.1:9998') {
    super();
    this.endpoint = endpoint;
    this.socket = null;
    this.isConnected = false;
    this.reconnectDelay = 5000;
    this.maxReconnectAttempts = Infinity;
    this.reconnectAttempts = 0;
  }
  
  async establish() {
    if (this.isConnected) {
      Logger.output('[ConnectionManager] 连接已存在');
      return Promise.resolve();
    }
    
    Logger.output('[ConnectionManager] 建立连接:', this.endpoint);
    
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.endpoint);
      
      this.socket.addEventListener('open', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        Logger.output('[ConnectionManager] 连接建立成功');
        this.dispatchEvent(new CustomEvent('connected'));
        resolve();
      });
      
      this.socket.addEventListener('close', () => {
        this.isConnected = false;
        Logger.output('[ConnectionManager] 连接断开，准备重连');
        this.dispatchEvent(new CustomEvent('disconnected'));
        this._scheduleReconnect();
      });
      
      this.socket.addEventListener('error', (error) => {
        Logger.output('[ConnectionManager] 连接错误:', error);
        this.dispatchEvent(new CustomEvent('error', { detail: error }));
        if (!this.isConnected) reject(error);
      });
      
      this.socket.addEventListener('message', (event) => {
        this.dispatchEvent(new CustomEvent('message', { detail: event.data }));
      });
    });
  }
  
  transmit(data) {
    if (!this.isConnected || !this.socket) {
      Logger.output('[ConnectionManager] 无法发送数据：连接未建立');
      return false;
    }
    
    this.socket.send(JSON.stringify(data));
    return true;
  }
  
  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      Logger.output('[ConnectionManager] 达到最大重连次数');
      return;
    }
    
    this.reconnectAttempts++;
    setTimeout(() => {
      Logger.output(`[ConnectionManager] 重连尝试 ${this.reconnectAttempts}`);
      this.establish().catch(() => {});
    }, this.reconnectDelay);
  }
}

// HTTP请求处理器
class RequestProcessor {
  constructor() {
    this.activeOperations = new Map();
    this.targetDomain = 'generativelanguage.googleapis.com';
  }
  
  async execute(requestSpec, operationId) {
    Logger.output('[RequestProcessor] 执行请求:', requestSpec.method, requestSpec.path, '(ID:', operationId, ')');

    const abortController = new AbortController();
    this.activeOperations.set(operationId, abortController);

    try {
      const requestUrl = this._constructUrl(requestSpec);
      const requestConfig = this._buildRequestConfig(requestSpec, abortController.signal);

      let lastError = null;
      const maxRetries = 15;
      const retryDelay = 1000; // 1 second

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (abortController.signal.aborted) {
          Logger.output('[RequestProcessor] Operation cancelled before attempt', attempt, 'for ID:', operationId);
          throw new Error('Operation cancelled');
        }

        try {
          Logger.output(`[RequestProcessor] Attempt ${attempt}/${maxRetries} for ${requestSpec.method} ${requestSpec.path} (ID: ${operationId})`);
          const response = await fetch(requestUrl, requestConfig);

          if (!response.ok) {
            let errorBody = '';
            try {
              errorBody = await response.text();
            } catch (e) {
              // ignore if can't read body
              Logger.output('[RequestProcessor] Could not read error response body for failed attempt', attempt, 'ID:', operationId);
            }
            throw new Error(`HTTP ${response.status}: ${response.statusText}. Body: ${errorBody}`);
          }
          
          Logger.output(`[RequestProcessor] Attempt ${attempt} successful for ${requestSpec.path} (ID: ${operationId})`);
          return response; 

        } catch (error) {
          lastError = error;

          if (error.name === 'AbortError' || abortController.signal.aborted) {
            Logger.output(`[RequestProcessor] Request aborted for ID: ${operationId} during attempt ${attempt}:`, error.message);
            throw error; 
          }
          
          Logger.output(`[RequestProcessor] Attempt ${attempt}/${maxRetries} failed for ${requestSpec.path} (ID: ${operationId}):`, error.message);

          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          } else {
            Logger.output(`[RequestProcessor] Max retries (${maxRetries}) reached for ${requestSpec.path} (ID: ${operationId}). Last error:`, error.message);
            // Fall through to throw lastError after the loop
          }
        }
      }
      
      // This part is reached only if all retries failed (and it wasn't an AbortError)
      throw lastError;

    } catch (error) {
      Logger.output('[RequestProcessor] Request execution failed ultimately for ID:', operationId, error.message);
      throw error; 
    } finally {
      this.activeOperations.delete(operationId);
      Logger.output('[RequestProcessor] Cleaned up active operation for ID:', operationId);
    }
  }
  
  cancelOperation(operationId) {
    const controller = this.activeOperations.get(operationId);
    if (controller) {
      controller.abort();
      // No need to delete here, 'finally' block in 'execute' will handle it.
      Logger.output('[RequestProcessor] 操作已取消 (signal sent):', operationId);
    }
  }
  
  cancelAllOperations() {
    this.activeOperations.forEach((controller, id) => {
      controller.abort();
      Logger.output('[RequestProcessor] 取消操作 (signal sent):', id);
    });
    // No need to clear here, 'finally' block in 'execute' will handle it for each operation.
  }
  
  _constructUrl(requestSpec) {
    const pathSegment = requestSpec.path.startsWith('/') ? 
      requestSpec.path.substring(1) : requestSpec.path;
    
    const queryParams = new URLSearchParams(requestSpec.query_params);
    const queryString = queryParams.toString();
    
    return `https://${this.targetDomain}/${pathSegment}${queryString ? '?' + queryString : ''}`;
  }
  
  _buildRequestConfig(requestSpec, signal) {
    const config = {
      method: requestSpec.method,
      headers: this._sanitizeHeaders(requestSpec.headers),
      signal
    };
    
    if (['POST', 'PUT', 'PATCH'].includes(requestSpec.method) && requestSpec.body) {
      config.body = requestSpec.body;
    }
    
    return config;
  }
  
  _sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    const forbiddenHeaders = [
      'host', 'connection', 'content-length', 'origin',
      'referer', 'user-agent', 'sec-fetch-mode',
      'sec-fetch-site', 'sec-fetch-dest'
    ];
    
    forbiddenHeaders.forEach(header => delete sanitized[header]);
    return sanitized;
  }
}

// 流式响应处理器
class StreamHandler {
  constructor(communicator) {
    this.communicator = communicator;
  }
  
  async processStream(response, operationId) {
    Logger.output('[StreamHandler] 开始处理流式响应 for ID:', operationId);
    
    this._transmitHeaders(response, operationId);
    
    const reader = response.body.getReader();
    const textDecoder = new TextDecoder();
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          Logger.output('[StreamHandler] 流处理完成 for ID:', operationId);
          this._transmitStreamEnd(operationId);
          break;
        }
        
        const textChunk = textDecoder.decode(value, { stream: true });
        this._transmitChunk(textChunk, operationId);
      }
    } catch (error) {
      Logger.output('[StreamHandler] 流处理错误 for ID:', operationId, error.message);
      // This error will be caught by ProxySystem if it propagates from here
      // We should ensure that if an error happens during streaming, ProxySystem handles it.
      // For now, just rethrow, it should be caught by _processProxyRequest's catch block
      // if this function is awaited properly.
      this._sendStreamError(error, operationId); // Send a specific stream error event
      throw error; // Rethrow so _processProxyRequest knows something went wrong
    }
  }
  
  _transmitHeaders(response, operationId) {
    const headerMap = {};
    response.headers.forEach((value, key) => {
      headerMap[key] = value;
    });
    
    const headerMessage = {
      request_id: operationId,
      event_type: 'response_headers',
      status: response.status,
      headers: headerMap
    };
    
    this.communicator.transmit(headerMessage);
    Logger.output('[StreamHandler] 响应头已传输 for ID:', operationId);
  }
  
  _transmitChunk(chunk, operationId) {
    const chunkMessage = {
      request_id: operationId,
      event_type: 'chunk',
      data: chunk
    };
    
    this.communicator.transmit(chunkMessage);
  }
  
  _transmitStreamEnd(operationId) {
    const endMessage = {
      request_id: operationId,
      event_type: 'stream_close'
    };
    
    this.communicator.transmit(endMessage);
  }

  _sendStreamError(error, operationId) {
    const errorMessage = {
      request_id: operationId,
      event_type: 'error', // Consistent with other error events
      status: 500, // Or a more specific stream error code if available
      message: `流处理错误 (ID: ${operationId}): ${error.message || '未知流错误'}`
    };
    this.communicator.transmit(errorMessage);
    Logger.output('[StreamHandler] 流错误响应已发送 for ID:', operationId);
  }
}

// 主代理系统
class ProxySystem extends EventTarget {
  constructor(websocketEndpoint) {
    super();
    this.connectionManager = new ConnectionManager(websocketEndpoint);
    this.requestProcessor = new RequestProcessor();
    this.streamHandler = new StreamHandler(this.connectionManager);
    
    this._setupEventHandlers();
  }
  
  async initialize() {
    Logger.output('[ProxySystem] 系统初始化中...');
    
    try {
      await this.connectionManager.establish();
      Logger.output('[ProxySystem] 系统初始化完成');
      this.dispatchEvent(new CustomEvent('ready'));
    } catch (error) {
      Logger.output('[ProxySystem] 系统初始化失败:', error.message);
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
      throw error;
    }
  }
  
  _setupEventHandlers() {
    this.connectionManager.addEventListener('message', (event) => {
      this._handleIncomingMessage(event.detail);
    });
    
    this.connectionManager.addEventListener('disconnected', () => {
      Logger.output('[ProxySystem] WebSocket disconnected, cancelling all operations.');
      this.requestProcessor.cancelAllOperations();
    });
  }
  
  async _handleIncomingMessage(messageData) {
    let requestSpec; // Define here to be accessible in catch
    try {
      requestSpec = JSON.parse(messageData);
      if (!requestSpec || !requestSpec.request_id) {
        Logger.output('[ProxySystem] 收到无效请求: 缺少 request_id 或格式错误', messageData);
        // Cannot send error response if request_id is missing.
        return;
      }
      Logger.output('[ProxySystem] 收到请求:', requestSpec.method, requestSpec.path, '(ID:', requestSpec.request_id, ')');
      
      await this._processProxyRequest(requestSpec);
    } catch (error) {
      Logger.output('[ProxySystem] 消息处理或格式错误:', error.message, 'Data:', messageData);
      // If requestSpec and request_id are available from a parse error, send error.
      // If JSON.parse fails, requestSpec might be undefined.
      const operationId = requestSpec ? requestSpec.request_id : null;
      if (operationId) {
        this._sendErrorResponse(error, operationId, '消息解析或初始处理错误');
      } else {
        Logger.output('[ProxySystem] 无法发送错误响应: 无效消息格式或缺少操作ID');
      }
    }
  }
  
  async _processProxyRequest(requestSpec) {
    const operationId = requestSpec.request_id;
    
    try {
      const response = await this.requestProcessor.execute(requestSpec, operationId);
      // If execute is successful (after retries), process the stream.
      await this.streamHandler.processStream(response, operationId);
    } catch (error) {
      // This error is now either an AbortError, an error after all retries from RequestProcessor,
      // or an error from StreamHandler.processStream.
      if (error.name === 'AbortError') {
        Logger.output('[ProxySystem] 请求被中止 (ID:', operationId, ')');
        // No error response needed for client-initiated aborts unless specifically required.
      } else {
        // This means all retries failed, or another unhandled error occurred.
        Logger.output('[ProxySystem] 请求处理失败 (ID:', operationId, '), 发送错误响应:', error.message);
        this._sendErrorResponse(error, operationId);
      }
    }
  }
  
  _sendErrorResponse(error, operationId, contextMessage = '代理系统错误') {
    if (!operationId) {
      Logger.output('[ProxySystem] 无法发送错误响应：缺少操作ID');
      return;
    }
    
    const errorMessage = {
      request_id: operationId,
      event_type: 'error',
      status: error.status || 500, // Use error's status if available (e.g. from HTTPError)
      message: `${contextMessage} (ID: ${operationId}): ${error.message || '未知错误'}`
    };
    
    this.connectionManager.transmit(errorMessage);
    Logger.output('[ProxySystem] 错误响应已发送 for ID:', operationId);
  }
}

// 系统启动函数
async function initializeProxySystem() {
  const proxySystem = new ProxySystem();
  
  try {
    await proxySystem.initialize();
    console.log('浏览器代理系统已成功启动');
    Logger.output('浏览器代理系统已成功启动');
  } catch (error) {
    console.error('代理系统启动失败:', error);
    Logger.output('代理系统启动失败:', error.message, error.stack);
  }
}

// 启动系统
initializeProxySystem();
