// ============================================================
//  SERVICE WORKER — Control Financiero Personal
//  Versión con notificaciones locales programadas
// ============================================================

const CACHE_NAME = 'finanzas-v4';
const BASE = '/Control-financiero-personal/';

const ARCHIVOS = [
    BASE,
    BASE + 'index.html',
    BASE + 'manifest.json',
    BASE + 'icon-192.png',
    BASE + 'icon-512.png'
];

// ── INSTALAR ─────────────────────────────────────────────────
self.addEventListener('install', e => {
    self.skipWaiting();
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ARCHIVOS))
    );
});

// ── ACTIVAR ──────────────────────────────────────────────────
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// ── FETCH ────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
    e.respondWith(
        caches.match(e.request).then(res =>
            res || fetch(e.request).catch(() => caches.match(BASE + 'index.html'))
        )
    );
});

// ── MENSAJES DESDE LA APP ────────────────────────────────────
// La app envía los datos financieros cada vez que hay cambios
self.addEventListener('message', e => {
    if (!e.data) return;

    switch (e.data.type) {
        case 'SCHEDULE_NOTIFICATIONS':
            guardarDatosYProgramar(e.data.payload);
            break;
        case 'CANCEL_NOTIFICATIONS':
            cancelarAlarmas();
            break;
        case 'TEST_NOTIFICATION':
            mostrarNotificacion(
                '🔔 Notificaciones Activadas',
                'Las notificaciones de Control Financiero están funcionando correctamente.',
                { tag: 'test', icon: BASE + 'icon-192.png' }
            );
            break;
    }
});

// ── PERIODIC BACKGROUND SYNC (si el navegador lo soporta) ───
self.addEventListener('periodicsync', e => {
    if (e.tag === 'check-finances') {
        e.waitUntil(verificarYNotificar());
    }
});

// ── PUSH (si en el futuro se agrega servidor push) ───────────
self.addEventListener('push', e => {
    const data = e.data ? e.data.json() : {};
    e.waitUntil(
        mostrarNotificacion(
            data.title || '💰 Control Financiero',
            data.body  || 'Tienes novedades financieras.',
            { tag: data.tag || 'push', data: data.url || BASE }
        )
    );
});

// ── CLIC EN NOTIFICACIÓN ─────────────────────────────────────
self.addEventListener('notificationclick', e => {
    e.notification.close();
    const url = (e.notification.data && e.notification.data.url) || BASE;
    e.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            // Si la app ya está abierta, enfocarla
            for (const client of clients) {
                if (client.url.includes(BASE) && 'focus' in client) {
                    return client.focus();
                }
            }
            // Si no, abrirla
            if (self.clients.openWindow) return self.clients.openWindow(BASE);
        })
    );
});

// ============================================================
//  LÓGICA DE NOTIFICACIONES
// ============================================================

// Timers activos (se limpian al reprogramar)
const _timers = [];

function cancelarAlarmas() {
    _timers.forEach(id => clearTimeout(id));
    _timers.length = 0;
}

async function guardarDatosYProgramar(payload) {
    // Guardar snapshot en IndexedDB para usarlo en background sync
    await idbSet('finanzas_snapshot', payload);
    programarAlarmas(payload);
}

function programarAlarmas(payload) {
    cancelarAlarmas();

    const ahora   = Date.now();
    const hoy     = new Date();
    const diaHoy  = hoy.getDate();
    const msHora  = 60 * 60 * 1000;
    const msDia   = 24 * msHora;

    const {
        fixedExpenses  = [],
        fixedIncomes   = [],
        savingsGoals   = [],
        disponible     = 0,
        presupuesto    = 0,
        username       = 'Usuario'
    } = payload;

    // ── 1. RESUMEN DIARIO a las 8:00 AM ─────────────────────
    const hoy8am = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), 8, 0, 0);
    let ms8am = hoy8am.getTime() - ahora;
    if (ms8am < 0) ms8am += msDia; // si ya pasó, programar para mañana

    _timers.push(setTimeout(() => {
        mostrarResumenDiario(payload);
        // Reprogramar cada 24h
        const id = setInterval(() => mostrarResumenDiario(payload), msDia);
        _timers.push(id);
    }, ms8am));

    // ── 2. GASTOS FIJOS PRÓXIMOS ─────────────────────────────
    fixedExpenses.filter(f => f.status === 'pending').forEach(gasto => {
        const diasRestantes = gasto.paymentDay - diaHoy;

        // Notificar 3 días antes
        if (diasRestantes === 3) {
            const ms = calcularMsHasta(9, 0); // a las 9am del mismo día
            _timers.push(setTimeout(() => {
                mostrarNotificacion(
                    '📌 Gasto fijo en 3 días',
                    `"${gasto.name}" vence el día ${gasto.paymentDay}. Valor: $${formatNum(gasto.amount)}`,
                    { tag: 'gasto-' + gasto.name, data: { url: BASE }, badge: BASE + 'icon-192.png' }
                );
            }, ms));
        }

        // Notificar 1 día antes
        if (diasRestantes === 1) {
            const ms = calcularMsHasta(9, 0);
            _timers.push(setTimeout(() => {
                mostrarNotificacion(
                    '⚠️ Gasto fijo mañana',
                    `"${gasto.name}" vence MAÑANA. Asegúrate de tener $${formatNum(gasto.amount)} disponible.`,
                    { tag: 'gasto-urgente-' + gasto.name, data: { url: BASE }, badge: BASE + 'icon-192.png' }
                );
            }, ms));
        }

        // Notificar el mismo día
        if (diasRestantes === 0) {
            const ms = calcularMsHasta(8, 30);
            _timers.push(setTimeout(() => {
                mostrarNotificacion(
                    '🚨 Pago HOY',
                    `"${gasto.name}" vence HOY. Valor: $${formatNum(gasto.amount)}. Marca como pagado en la app.`,
                    { tag: 'gasto-hoy-' + gasto.name, data: { url: BASE }, badge: BASE + 'icon-192.png' }
                );
            }, ms));
        }
    });

    // ── 3. INGRESOS FIJOS PRÓXIMOS ───────────────────────────
    fixedIncomes.filter(f => f.status === 'pending').forEach(ingreso => {
        const diasRestantes = ingreso.paymentDay - diaHoy;

        if (diasRestantes === 1) {
            const ms = calcularMsHasta(9, 0);
            _timers.push(setTimeout(() => {
                mostrarNotificacion(
                    '💵 Ingreso mañana',
                    `"${ingreso.name}" se recibe MAÑANA. Valor esperado: $${formatNum(ingreso.amount)}`,
                    { tag: 'ingreso-' + ingreso.name, data: { url: BASE } }
                );
            }, ms));
        }

        if (diasRestantes === 0) {
            const ms = calcularMsHasta(8, 30);
            _timers.push(setTimeout(() => {
                mostrarNotificacion(
                    '💰 Ingreso esperado HOY',
                    `"${ingreso.name}" debería llegar HOY. $${formatNum(ingreso.amount)}. Márcalo como recibido.`,
                    { tag: 'ingreso-hoy-' + ingreso.name, data: { url: BASE } }
                );
            }, ms));
        }
    });

    // ── 4. METAS PRÓXIMAS A VENCER ───────────────────────────
    savingsGoals.forEach(meta => {
        if (!meta.date) return;
        const fechaMeta   = new Date(meta.date + 'T00:00:00').getTime();
        const diasParaMeta = Math.ceil((fechaMeta - ahora) / msDia);
        const progreso     = meta.amount > 0 ? (meta.current / meta.amount) * 100 : 0;

        if (diasParaMeta === 7 && progreso < 100) {
            const ms = calcularMsHasta(10, 0);
            _timers.push(setTimeout(() => {
                mostrarNotificacion(
                    '🎯 Meta próxima a vencer',
                    `"${meta.name}" vence en 7 días. Progreso: ${progreso.toFixed(0)}% ($${formatNum(meta.current)} de $${formatNum(meta.amount)})`,
                    { tag: 'meta-' + meta.name, data: { url: BASE } }
                );
            }, ms));
        }

        if (diasParaMeta === 1 && progreso < 100) {
            const ms = calcularMsHasta(9, 0);
            _timers.push(setTimeout(() => {
                mostrarNotificacion(
                    '⏰ Meta vence mañana',
                    `"${meta.name}" vence MAÑANA y solo llevas el ${progreso.toFixed(0)}%. Faltan $${formatNum(meta.amount - meta.current)}.`,
                    { tag: 'meta-urgente-' + meta.name, data: { url: BASE } }
                );
            }, ms));
        }
    });

    // ── 5. ALERTA DE BALANCE CRÍTICO (inmediata) ─────────────
    if (presupuesto > 0) {
        const porcentajeUsado = presupuesto > 0 ? ((presupuesto - disponible) / presupuesto) * 100 : 0;
        if (porcentajeUsado >= 90) {
            const ms = 5000; // 5 segundos después de programar
            _timers.push(setTimeout(() => {
                mostrarNotificacion(
                    '🚨 Balance Crítico',
                    `Has usado el ${porcentajeUsado.toFixed(0)}% de tu presupuesto. Solo te quedan $${formatNum(disponible)} disponibles.`,
                    { tag: 'balance-critico', data: { url: BASE } }
                );
            }, ms));
        } else if (porcentajeUsado >= 75) {
            const ms = 5000;
            _timers.push(setTimeout(() => {
                mostrarNotificacion(
                    '⚠️ Presupuesto al 75%',
                    `Llevas el ${porcentajeUsado.toFixed(0)}% del presupuesto usado. Disponible restante: $${formatNum(disponible)}.`,
                    { tag: 'balance-advertencia', data: { url: BASE } }
                );
            }, ms));
        }
    }
}

// ── Verificación en background sync ─────────────────────────
async function verificarYNotificar() {
    const snapshot = await idbGet('finanzas_snapshot');
    if (!snapshot) return;
    programarAlarmas(snapshot);
}

// ── Resumen diario ───────────────────────────────────────────
function mostrarResumenDiario(payload) {
    const {
        disponible     = 0,
        gastosMes      = 0,
        ingresosMes    = 0,
        fixedPendientes = 0,
        metasActivas   = 0,
        username       = 'Usuario'
    } = payload;

    const emoji = disponible > 0 ? '✅' : '⚠️';
    mostrarNotificacion(
        `${emoji} Resumen financiero — ${new Date().toLocaleDateString('es-CO', { weekday: 'long' })}`,
        `Disponible: $${formatNum(disponible)} | Gastos del mes: $${formatNum(gastosMes)} | Fijos pendientes: ${fixedPendientes} | Metas activas: ${metasActivas}`,
        { tag: 'resumen-diario', renotify: true, data: { url: BASE } }
    );
}

// ── Mostrar notificación ─────────────────────────────────────
function mostrarNotificacion(titulo, cuerpo, opciones = {}) {
    return self.registration.showNotification(titulo, {
        body:    cuerpo,
        icon:    BASE + 'icon-192.png',
        badge:   BASE + 'icon-192.png',
        vibrate: [200, 100, 200],
        requireInteraction: false,
        ...opciones
    });
}

// ── Utilidades ───────────────────────────────────────────────
function calcularMsHasta(hora, minutos) {
    const ahora = new Date();
    const target = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), hora, minutos, 0);
    let ms = target.getTime() - Date.now();
    if (ms < 0) ms = 1000; // si ya pasó, mostrar casi inmediatamente
    return ms;
}

function formatNum(n) {
    return Math.round(n || 0).toLocaleString('es-CO');
}

// ── IndexedDB simple para persistir snapshot ─────────────────
function idbSet(key, value) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('finanzas_sw_db', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => {
            const tx = req.result.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(value, key);
            tx.oncomplete = resolve;
            tx.onerror = reject;
        };
        req.onerror = reject;
    });
}

function idbGet(key) {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('finanzas_sw_db', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => {
            const tx = req.result.transaction('kv', 'readonly');
            const get = tx.objectStore('kv').get(key);
            get.onsuccess = () => resolve(get.result || null);
            get.onerror = reject;
        };
        req.onerror = reject;
    });
}