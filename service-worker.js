// ============================================================
//  SERVICE WORKER — Control Financiero Personal
//  Notificaciones programadas que funcionan con app CERRADA
//  Estrategia: Notification Triggers API + fallback periódico
// ============================================================

const CACHE_NAME = 'finanzas-v5';
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
        caches.open(CACHE_NAME).then(c => c.addAll(ARCHIVOS))
    );
});

// ── ACTIVAR ──────────────────────────────────────────────────
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
            .then(() => verificarAlarmasPendientes()) // ← revisar alarmas al activarse
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

// ── PERIODIC BACKGROUND SYNC ─────────────────────────────────
// Se ejecuta una vez al día aunque la app esté cerrada (Chrome Android)
self.addEventListener('periodicsync', e => {
    if (e.tag === 'check-finances') {
        e.waitUntil(verificarAlarmasPendientes());
    }
});

// ── MENSAJES DESDE LA APP ────────────────────────────────────
self.addEventListener('message', e => {
    if (!e.data) return;
    switch (e.data.type) {
        case 'SCHEDULE_NOTIFICATIONS':
            e.waitUntil(guardarYProgramarTodo(e.data.payload));
            break;
        case 'TEST_NOTIFICATION':
            e.waitUntil(mostrarNotificacion(
                '🔔 Notificaciones Activadas',
                'Las notificaciones de Control Financiero están funcionando correctamente.',
                { tag: 'test' }
            ));
            break;
    }
});

// ── CLIC EN NOTIFICACIÓN ─────────────────────────────────────
self.addEventListener('notificationclick', e => {
    e.notification.close();
    e.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            for (const c of clients) {
                if (c.url.includes(BASE) && 'focus' in c) return c.focus();
            }
            return self.clients.openWindow(BASE);
        })
    );
});

// ── SYNC (one-off, cuando recupera conexión) ─────────────────
self.addEventListener('sync', e => {
    if (e.tag === 'check-finances-sync') {
        e.waitUntil(verificarAlarmasPendientes());
    }
});

// ============================================================
//  MOTOR DE ALARMAS — persiste en IndexedDB
// ============================================================

// Estructura de una alarma guardada:
// { id, titulo, cuerpo, timestamp, tag, disparada }

async function guardarYProgramarTodo(payload) {
    await idbSet('finanzas_snapshot', payload);

    const alarmas = construirAlarmas(payload);
    await idbSet('finanzas_alarmas', alarmas);

    // Intentar usar Notification Triggers API (Chrome 80+, experimental)
    // Si no está disponible, el fallback es periodicsync + verificación al abrir
    await programarConTriggers(alarmas);

    // Verificar inmediatamente si alguna ya debería haber disparado
    await verificarAlarmasPendientes();
}

function construirAlarmas(payload) {
    const alarmas = [];
    const ahora   = Date.now();
    const hoy     = new Date();
    const diaHoy  = hoy.getDate();
    const mesHoy  = hoy.getMonth();
    const anioHoy = hoy.getFullYear();
    const msDia   = 24 * 60 * 60 * 1000;

    const {
        fixedExpenses = [], fixedIncomes = [],
        savingsGoals  = [], disponible   = 0,
        presupuesto   = 0,  gastosMes    = 0,
        ingresosMes   = 0,  fixedPendientes = 0,
        metasActivas  = 0,  libreParaGastar = 0,
        diasRestantes = 0
    } = payload;

    // ── 1. RESUMEN DIARIO — 8:30 AM ──────────────────────────
    const resumen8am = tsHoy(8, 30, hoy);
    const resumenManana = resumen8am + msDia;
    const tsResumen = resumen8am > ahora ? resumen8am : resumenManana;

    const limiteDiario = diasRestantes > 0
        ? Math.max(0, libreParaGastar / diasRestantes)
        : 0;
    const limiteDiarioFmt = formatNum(limiteDiario);
    const disponibleFmt   = formatNum(disponible);

    const resumenBody = disponible > 0
        ? `Disponible: $${disponibleFmt} | Gastos del mes: $${formatNum(gastosMes)} | Fijos pendientes: ${fixedPendientes} | Metas: ${metasActivas}\nHoy puedes gastar hasta: $${limiteDiarioFmt}`
        : `⚠️ Sin margen disponible — revisa tus finanzas | Fijos pendientes: ${fixedPendientes} | Metas: ${metasActivas}`;

    alarmas.push({
        id:        'resumen-diario',
        titulo:    `✅ Resumen financiero — ${nombreDia(tsResumen)}`,
        cuerpo:    resumenBody,
        timestamp: tsResumen,
        tag:       'resumen-diario',
        disparada: false,
        recurrente: true,
        intervalo:  msDia
    });

    // ── 2. RECORDATORIO CIERRE DÍA — 7:00 PM ─────────────────
    const ts7pm      = tsHoy(19, 0, hoy);
    const ts7pmFinal = ts7pm > ahora ? ts7pm : ts7pm + msDia;

    alarmas.push({
        id:        'cierre-dia',
        titulo:    '📝 ¿Registraste todo hoy?',
        cuerpo:    '¿Hiciste algún pago en efectivo, transferencia o compra que no registraste en la app? Hazlo ahora antes de que se te olvide.',
        timestamp: ts7pmFinal,
        tag:       'cierre-dia',
        disparada: false,
        recurrente: true,
        intervalo:  msDia
    });

    // ── 3. GASTOS FIJOS ───────────────────────────────────────
    fixedExpenses.filter(f => f.status === 'pending').forEach(gasto => {
        const diasRestantesGasto = gasto.paymentDay - diaHoy;

        // 3 días antes — 9:00 AM
        if (diasRestantesGasto >= 3) {
            const ts = tsEnDias(diasRestantesGasto - 3, 9, 0, hoy);
            if (ts > ahora) alarmas.push({
                id: `gasto-3d-${gasto.name}`,
                titulo: '📌 Gasto fijo en 3 días',
                cuerpo: `"${gasto.name}" vence el día ${gasto.paymentDay}. Valor: $${formatNum(gasto.amount)}`,
                timestamp: ts, tag: `gasto-3d-${slugify(gasto.name)}`, disparada: false
            });
        }

        // 1 día antes — 9:00 AM
        if (diasRestantesGasto >= 1) {
            const ts = tsEnDias(diasRestantesGasto - 1, 9, 0, hoy);
            if (ts > ahora) alarmas.push({
                id: `gasto-1d-${gasto.name}`,
                titulo: '⚠️ Gasto fijo mañana',
                cuerpo: `"${gasto.name}" vence MAÑANA. Asegúrate de tener $${formatNum(gasto.amount)} disponible.`,
                timestamp: ts, tag: `gasto-1d-${slugify(gasto.name)}`, disparada: false
            });
        }

        // El mismo día — 8:30 AM
        if (diasRestantesGasto >= 0) {
            const ts = tsEnDias(diasRestantesGasto, 8, 30, hoy);
            if (ts > ahora) alarmas.push({
                id: `gasto-hoy-${gasto.name}`,
                titulo: '🚨 Pago HOY',
                cuerpo: `"${gasto.name}" vence HOY. Valor: $${formatNum(gasto.amount)}. Marca como pagado en la app.`,
                timestamp: ts, tag: `gasto-hoy-${slugify(gasto.name)}`, disparada: false
            });
        }
    });

    // ── 4. INGRESOS FIJOS ─────────────────────────────────────
    fixedIncomes.filter(f => f.status === 'pending').forEach(ingreso => {
        const dias = ingreso.paymentDay - diaHoy;

        // 1 día antes — 9:00 AM
        if (dias >= 1) {
            const ts = tsEnDias(dias - 1, 9, 0, hoy);
            if (ts > ahora) alarmas.push({
                id: `ingreso-1d-${ingreso.name}`,
                titulo: '💵 Ingreso mañana',
                cuerpo: `"${ingreso.name}" se recibe MAÑANA. Valor esperado: $${formatNum(ingreso.amount)}`,
                timestamp: ts, tag: `ingreso-1d-${slugify(ingreso.name)}`, disparada: false
            });
        }

        // El mismo día — 8:30 AM
        if (dias >= 0) {
            const ts = tsEnDias(dias, 8, 30, hoy);
            if (ts > ahora) alarmas.push({
                id: `ingreso-hoy-${ingreso.name}`,
                titulo: '💰 Ingreso esperado HOY',
                cuerpo: `"${ingreso.name}" debería llegar HOY. $${formatNum(ingreso.amount)}. Márcalo como recibido.`,
                timestamp: ts, tag: `ingreso-hoy-${slugify(ingreso.name)}`, disparada: false
            });
        }
    });

    // ── 5. METAS ──────────────────────────────────────────────
    savingsGoals.forEach(meta => {
        if (!meta.date) return;
        const fechaMeta    = new Date(meta.date + 'T00:00:00').getTime();
        const diasParaMeta = Math.ceil((fechaMeta - ahora) / msDia);
        const progreso     = meta.amount > 0 ? (meta.current / meta.amount) * 100 : 0;

        if (diasParaMeta === 7 && progreso < 100) {
            const ts = tsEnDias(0, 10, 0, hoy);
            if (ts > ahora) alarmas.push({
                id: `meta-7d-${meta.name}`,
                titulo: '🎯 Meta próxima a vencer',
                cuerpo: `"${meta.name}" vence en 7 días. Progreso: ${progreso.toFixed(0)}% ($${formatNum(meta.current)} de $${formatNum(meta.amount)})`,
                timestamp: ts, tag: `meta-7d-${slugify(meta.name)}`, disparada: false
            });
        }

        if (diasParaMeta === 1 && progreso < 100) {
            const ts = tsEnDias(0, 9, 0, hoy);
            if (ts > ahora) alarmas.push({
                id: `meta-1d-${meta.name}`,
                titulo: '⏰ Meta vence mañana',
                cuerpo: `"${meta.name}" vence MAÑANA y solo llevas el ${progreso.toFixed(0)}%. Faltan $${formatNum(meta.amount - meta.current)}.`,
                timestamp: ts, tag: `meta-1d-${slugify(meta.name)}`, disparada: false
            });
        }
    });

    // ── 6. BALANCE CRÍTICO ────────────────────────────────────
    if (presupuesto > 0) {
        const pct = ((presupuesto - disponible) / presupuesto) * 100;
        if (pct >= 90) {
            alarmas.push({
                id: 'balance-critico',
                titulo: '🚨 Balance Crítico',
                cuerpo: `Has usado el ${pct.toFixed(0)}% de tu presupuesto. Solo te quedan $${formatNum(disponible)} disponibles.`,
                timestamp: ahora + 5000,
                tag: 'balance-critico', disparada: false
            });
        } else if (pct >= 75) {
            alarmas.push({
                id: 'balance-advertencia',
                titulo: '⚠️ Presupuesto al 75%',
                cuerpo: `Llevas el ${pct.toFixed(0)}% del presupuesto usado. Disponible restante: $${formatNum(disponible)}.`,
                timestamp: ahora + 5000,
                tag: 'balance-advertencia', disparada: false
            });
        }
    }

    return alarmas;
}

// ── Notification Triggers API (donde esté soportada) ─────────
async function programarConTriggers(alarmas) {
    if (!('showTrigger' in Notification.prototype)) return; // no soportado

    for (const a of alarmas) {
        if (a.disparada || a.timestamp <= Date.now()) continue;
        try {
            await self.registration.showNotification(a.titulo, {
                body:        a.cuerpo,
                tag:         a.tag,
                icon:        BASE + 'icon-192.png',
                badge:       BASE + 'icon-192.png',
                vibrate:     [200, 100, 200],
                showTrigger: new TimestampTrigger(a.timestamp)
            });
        } catch (err) {
            // showTrigger puede fallar si el timestamp ya pasó o hay cuota
            console.warn('[SW] Trigger falló para', a.id, err.message);
        }
    }
}

// ── Verificar alarmas pendientes (fallback universal) ─────────
// Se ejecuta: al activar el SW, en periodicsync, al recibir mensaje
async function verificarAlarmasPendientes() {
    const alarmas = await idbGet('finanzas_alarmas');
    if (!alarmas || !alarmas.length) return;

    const ahora    = Date.now();
    let   cambios  = false;

    for (const a of alarmas) {
        if (a.disparada) continue;
        if (a.timestamp > ahora) continue;

        await mostrarNotificacion(a.titulo, a.cuerpo, {
            tag:     a.tag,
            renotify: !!a.recurrente
        });

        if (a.recurrente && a.intervalo) {
            // Reprogramar para el siguiente ciclo
            while (a.timestamp <= ahora) a.timestamp += a.intervalo;
        } else {
            a.disparada = true;
        }
        cambios = true;
    }

    if (cambios) await idbSet('finanzas_alarmas', alarmas);
}

// ── Mostrar notificación ──────────────────────────────────────
function mostrarNotificacion(titulo, cuerpo, opts = {}) {
    return self.registration.showNotification(titulo, {
        body:    cuerpo,
        icon:    BASE + 'icon-192.png',
        badge:   BASE + 'icon-192.png',
        vibrate: [200, 100, 200],
        requireInteraction: false,
        ...opts
    });
}

// ── Helpers de tiempo ─────────────────────────────────────────
function tsHoy(h, m, ref) {
    return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h, m, 0).getTime();
}

function tsEnDias(dias, h, m, ref) {
    const base = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + dias, h, m, 0);
    return base.getTime();
}

function nombreDia(ts) {
    return new Date(ts).toLocaleDateString('es-CO', { weekday: 'long' });
}

function formatNum(n) {
    return Math.round(n || 0).toLocaleString('es-CO');
}

function slugify(str) {
    return (str || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// ── IndexedDB ─────────────────────────────────────────────────
function idbSet(key, value) {
    return new Promise((res, rej) => {
        const r = indexedDB.open('finanzas_sw_db', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => {
            const tx = r.result.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(value, key);
            tx.oncomplete = res;
            tx.onerror = rej;
        };
        r.onerror = rej;
    });
}

function idbGet(key) {
    return new Promise((res, rej) => {
        const r = indexedDB.open('finanzas_sw_db', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => {
            const tx  = r.result.transaction('kv', 'readonly');
            const req = tx.objectStore('kv').get(key);
            req.onsuccess = () => res(req.result || null);
            req.onerror = rej;
        };
        r.onerror = rej;
    });
}