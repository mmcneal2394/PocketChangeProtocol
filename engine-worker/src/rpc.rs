use solana_client::rpc_client::RpcClient;

pub struct FallbackRpcClient {
    clients: Vec<RpcClient>,
    current: std::sync::atomic::AtomicUsize,
}

impl FallbackRpcClient {
    pub fn new(urls: Vec<String>) -> Self {
        let clients = urls.into_iter()
            .map(|url| RpcClient::new(url))
            .collect();
        Self {
            clients,
            current: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    pub fn get(&self) -> &RpcClient {
        let idx = self.current.load(std::sync::atomic::Ordering::Relaxed);
        &self.clients[idx]
    }

    pub fn rotate(&self) {
        let len = self.clients.len();
        if len > 1 {
            self.current.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let idx = self.current.load(std::sync::atomic::Ordering::Relaxed);
            if idx >= len {
                self.current.store(0, std::sync::atomic::Ordering::Relaxed);
            }
        }
    }
}
