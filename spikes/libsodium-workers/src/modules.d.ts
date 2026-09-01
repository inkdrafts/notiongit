declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}

declare module 'libsodium-raw' {
  const rawFactory: (options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  export default rawFactory;
}
