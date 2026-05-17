const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

const app = express();
const PORT = process.env.PORT || 3005;
const paymentEvents = new EventEmitter();

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

// Configuration state
const CONFIG_FILE = path.join(__dirname, 'admin_config.json');
let config = {
    activeGateway: 'blackcat',
    adminUsername: 'admin',
    adminPassword: 'pizza2024',
    blackcatSecret: 'sk_live_e83eb7792e98d74ecd8fbe18d5f816fc031f0a5acb1278e0a0e0b682fa10f0c3',
    blackcatPublic: 'pk_live_2436f0a186a6a9d89d63c75472a1a447a93e22b74efae5a1c4ac1f117ecde9e4',
    paradiseSecret: 'sk_9743cb5f3daa665f2d812e5326c2b10ed69517ea9111d7e60a67206de3b736f3'
};

if (fs.existsSync(CONFIG_FILE)) {
    try {
        const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE));
        config = { ...config, ...savedConfig };
    } catch (e) { console.error("Erro ao ler config:", e); }
}

// Data Generation Utilities (VALID CPF, NAME, EMAIL)
function generateCPF() {
    const r = () => Math.floor(Math.random() * 9);
    const n = Array.from({length: 9}, r);
    const calc = (n, m) => {
        const s = n.reduce((acc, curr, i) => acc + curr * (m - i), 0);
        const v = 11 - (s % 11);
        return v >= 10 ? 0 : v;
    };
    n.push(calc(n, 10));
    n.push(calc(n, 11));
    return n.join('');
}

const firstNames = ['Marcos', 'Lucas', 'Ana', 'Julia', 'Roberto', 'Camila', 'Tiago', 'Bruna', 'Felipe', 'Mariana', 'Ricardo', 'Beatriz', 'Guilherme', 'Vanessa', 'Leandro'];
const lastNames = ['Silva', 'Santos', 'Oliveira', 'Souza', 'Rodrigues', 'Ferreira', 'Alves', 'Pereira', 'Lima', 'Gomes', 'Costa', 'Ribeiro', 'Martins', 'Carvalho', 'Almeida'];

function generateName() {
    const fn = firstNames[Math.floor(Math.random() * firstNames.length)];
    const ln1 = lastNames[Math.floor(Math.random() * lastNames.length)];
    const ln2 = lastNames[Math.floor(Math.random() * lastNames.length)];
    return `${fn} ${ln1} ${ln2}`;
}

function generateEmail(name) {
    const domains = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com.br'];
    const cleanName = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, '.');
    const randomNum = Math.floor(Math.random() * 999);
    return `${cleanName}${randomNum}@${domains[Math.floor(Math.random() * domains.length)]}`;
}

// Visitor tracking
const visitors = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [id, lastSeen] of visitors.entries()) {
        if (now - lastSeen > 20000) { // 20 segundos sem sinal = offline
            visitors.delete(id);
        }
    }
}, 5000);

// API Endpoints
app.post('/api/heartbeat', (req, res) => {
    const { visitorId, visitor_id } = req.body;
    const id = visitor_id || visitorId;
    if (id) {
        visitors.set(id, Date.now());
    }
    res.json({ success: true, activeGateway: config.activeGateway });
});

app.get('/api/stats', (req, res) => {
    res.json({ onlineUsers: visitors.size, activeGateway: config.activeGateway });
});

// MULTI-GATEWAY PIX API
app.post('/api/create-pix', async (req, res) => {
    const { amount, phone, customer, description } = req.body;
    
    // Use data from request or generate if missing
    const name = (customer && customer.name) || generateName();
    const email = (customer && customer.email) || generateEmail(name);
    const cpf = (customer && customer.document) || generateCPF();
    const finalAmountCents = Math.round(Number(amount));

    console.log(`[Gateway] Usando: ${config.activeGateway} | R$ ${finalAmountCents/100} | ${phone}`);

    try {
        if (config.activeGateway === 'blackcat') {
            const response = await fetch('https://api.blackcatpay.com.br/api/sales/create-sale', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': config.blackcatSecret
                },
                body: JSON.stringify({
                    amount: finalAmountCents,
                    currency: 'BRL',
                    paymentMethod: 'pix',
                    items: [
                        { title: 'mini curso 30 dias', quantity: 1, unitPrice: finalAmountCents, tangible: false }
                    ],
                    customer: {
                        name: name,
                        email: email,
                        phone: phone || '11999999999',
                        document: {
                            number: cpf,
                            type: 'cpf'
                        }
                    },
                    pix: { expiresInDays: 1 }
                })
            });

            const result = await response.json();
            if (result.success) {
                return res.json({
                    status: 'success',
                    qr_code: result.data.paymentData.qrCode || result.data.paymentData.copyPaste,
                    transaction_id: result.data.transactionId,
                    id: result.data.transactionId
                });
            } else {
                return res.status(400).json({ status: 'error', message: result.message || 'Erro Blackcat' });
            }

        } else if (config.activeGateway === 'paradise') {
            // PARADISE PAGS INTEGRATION
            const response = await fetch('https://multi.paradisepags.com/api/v1/transaction.php', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': config.paradiseSecret
                },
                body: JSON.stringify({
                    amount: (finalAmountCents / 100).toFixed(2), // Paradise usually expects decimal string like "20.00"
                    description: description || 'EBOOK EMAGRECIMENTO',
                    reference: 'REC-' + Date.now(),
                    customer: {
                        name: name,
                        email: email,
                        phone: phone || '11999999999',
                        document: cpf
                    },
                    source: "api_externa"
                })
            });

            const result = await response.json();
            if (result.status === 'success' || result.qr_code) {
                return res.json({
                    status: 'success',
                    qr_code: result.qr_code,
                    transaction_id: result.transaction_id || result.id,
                    id: result.id || result.transaction_id
                });
            } else {
                return res.status(400).json({ status: 'error', message: result.message || 'Erro Paradise' });
            }
        } else {
            res.status(500).json({ status: 'error', message: 'Nenhum gateway configurado' });
        }
    } catch (err) {
        console.error('[Gateway Error]', err);
        res.status(500).json({ status: 'error', message: 'Erro ao processar pagamento' });
    }
});

// Rota de consulta do polling do Frontend (Usada pelo React)
app.get('/api/query', async (req, res) => {
    const transactionId = req.query.id;
    if (!transactionId) {
        return res.json({ status: 'pending' });
    }

    try {
        const fetchRes = await fetch(`https://api.blackcatpay.com.br/api/sales/${transactionId}/status`, {
            method: 'GET',
            headers: {
                // Usa a chave secreta (sk_live_) correta para verificar o status
                'X-API-Key': 'sk_live_e83eb7792e98d74ecd8fbe18d5f816fc031f0a5acb1278e0a0e0b682fa10f0c3'
            }
        });
        const data = await fetchRes.json();
        
        if (data && data.success && data.data && data.data.status === 'PAID') {
            return res.json({ status: 'paid' });
        }
        
        res.json({ status: 'pending' });
    } catch (error) {
        console.error('[API Query] Erro ao consultar status na Blackcat:', error);
        res.json({ status: 'pending' });
    }
});

// SSE Endpoint (Server-Sent Events) - Sem polling
app.get('/api/stream', (req, res) => {
    const transactionId = req.query.id;
    if (!transactionId) return res.status(400).send('Missing id');

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });

    // Envia um comentário inicial para manter a conexão ativa
    res.write(': connected\n\n');

    const onPay = (paidId) => {
        if (paidId === transactionId) {
            res.write(`data: ${JSON.stringify({ status: 'paid' })}\n\n`);
        }
    };

    paymentEvents.on('paid', onPay);

    req.on('close', () => {
        paymentEvents.off('paid', onPay);
    });
});

// Webhook Endpoint
app.post('/api/webhook', (req, res) => {
    const payload = req.body;
    console.log('[Webhook] Recebido:', JSON.stringify(payload, null, 2));

    // Suporta o formato da Blackcat (event === 'transaction.paid') ou genérico
    if (payload.event === 'transaction.paid' || payload.status === 'PAID') {
        const transactionId = payload.transactionId || payload.id;
        if (transactionId) {
            console.log(`[Webhook] Pagamento PIX confirmado! Transação: ${transactionId}`);
            paymentEvents.emit('paid', transactionId);
        }
    }
    
    // Gateway exige retorno rápido 200 OK
    res.status(200).json({ received: true });
});

// Admin endpoints
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body;
    if (username === config.adminUsername && password === config.adminPassword) {
        res.json({ success: true, token: 'admin-token' });
    } else {
        res.status(401).json({ success: false });
    }
});

app.post('/api/admin/gateway', (req, res) => {
    const { gateway } = req.body;
    config.activeGateway = gateway;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`[Admin] Gateway alterado para: ${gateway}`);
    res.json({ success: true });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'index.html')));
app.get('/admin/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'admin', 'dashboard.html')));

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
