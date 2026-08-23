export type JsonObject = Record<string, unknown>;

export interface RpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export type AppServerMessage = RpcRequest | RpcResponse | RpcNotification;

export type BrowserMessage =
  | { type: "auth"; token: string }
  | { type: "rpc"; id: string; method: string; params?: unknown }
  | { type: "serverResponse"; id: number | string; result?: unknown; error?: { message: string } };

export type BridgeMessage =
  | { type: "ready"; version: string; initialized: unknown }
  | { type: "rpcResult"; id: string; result?: unknown; error?: { message: string; data?: unknown } }
  | { type: "event"; method: string; params?: unknown }
  | { type: "serverRequest"; id: number | string; method: string; params?: unknown }
  | { type: "fatal"; message: string };
