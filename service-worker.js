// ============================================================
//  SERVICE WORKER — Control Financiero Personal  v4.0
//  Basado en v3 original. Correcciones aplicadas:
//
//  ✅ IndexedDB singleton (evita conflictos de conexión paralela)
//  ✅ Guards para paymentDay < diaHoy (timestamps negativos)
//  ✅ Re-registro de Triggers para alarmas recurrentes
//  ✅ fetch dispara verificarAlarmasPendientes (wake-up en desktop)
//  ✅ Balance crítico/advertencia: solo 1 vez por día (no spam)
//  ✅ message handler compatible con ExtendableMessageEvent
//  ✅ Evento 'push' implementado
//  ✅ GET_STATUS y CLEAR_SCHEDULE añadidos
//  ✅ Toda la lógica financiera original intacta
// ============================================================

const CACHE_NAME = 'finanzas-v7';   // bump para limpiar caché anterior
const BASE = '/Control-financiero-personal/';

const ARCHIVOS = [
    BASE + 'icon-192.png',
    BASE + 'icon-512.png'
];

const NETWORK_FIRST = [
    BASE,
    BASE + 'index.html',
    BASE + 'manifest.json'
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
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
            .then(() => verificarAlarmasPendientes())
    );
});

// ── FETCH — Network-First para HTML/manifest, Cache-First para el resto ──
// CORRECCIÓN: dispara verificarAlarmasPendientes() en segundo plano.
// En PC/desktop sin periodicSync esto es el único "wake-up" disponible.
self.addEventListener('fetch', e => {
    // Verificar alarmas de forma no bloqueante (no afecta tiempo de respuesta)
    verificarAlarmasPendientes().catch(() => {});

    const url      = new URL(e.request.url);
    const pathname = url.pathname;

    const esNetworkFirst = NETWORK_FIRST.some(p =>
        pathname === p || pathname === p.replace(/\/$/, '')
    );

    if (esNetworkFirst) {
        e.respondWith(
            fetch(e.request)
                .then(res => {
                    const copia = res.clone();
                    caches.open(CACHE_NAME).then(c => c.put(e.request, copia));
                    return res;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }

    e.respondWith(
        caches.match(e.request).then(res =>
            res || fetch(e.request).catch(() => caches.match(BASE + 'index.html'))
        )
    );
});

// ── PERIODIC BACKGROUND SYNC ─────────────────────────────────
self.addEventListener('periodicsync', e => {
    if (e.tag === 'check-finances') {
        e.waitUntil(verificarAlarmasPendientes());
    }
});

// ── SYNC (one-off, cuando recupera conexión) ─────────────────
self.addEventListener('sync', e => {
    if (e.tag === 'check-finances-sync') {
        e.waitUntil(verificarAlarmasPendientes());
    }
});

// ── PUSH (servidor → SW) ──────────────────────────────────────
// Preparado para Web Push real. También aprovecha el wake-up para
// verificar alarmas locales pendientes.
self.addEventListener('push', e => {
    e.waitUntil(
        (async () => {
            await verificarAlarmasPendientes();

            if (!e.data) return;
            try {
                const data = e.data.json();
                await mostrarNotificacion(
                    data.titulo || data.title || '💰 Control Financiero',
                    data.cuerpo  || data.body  || '',
                    { tag: data.tag || 'push-servidor' }
                );
            } catch {
                await mostrarNotificacion(
                    '💰 Control Financiero',
                    e.data.text(),
                    { tag: 'push-servidor' }
                );
            }
        })()
    );
});

// ── MENSAJES DESDE LA APP ─────────────────────────────────────
// CORRECCIÓN: usa ExtendableMessageEvent.waitUntil cuando está
// disponible; cae en promesa directa como respaldo seguro.
self.addEventListener('message', e => {
    if (!e.data) return;

    const responder = msg => {
        if (e.source) e.source.postMessage(msg);
    };

    const tarea = (async () => {
        switch (e.data.type) {

            case 'SCHEDULE_NOTIFICATIONS':
                await guardarYProgramarTodo(e.data.payload);
                responder({
                    type:  'SCHEDULE_CONFIRMED',
                    count: (await idbGet('finanzas_alarmas') || []).length
                });
                break;

            case 'TEST_NOTIFICATION':
                await mostrarNotificacion(
                    '🔔 Notificaciones Activadas',
                    'Las notificaciones de Control Financiero están funcionando. Recibirás alertas automáticas aunque la app esté cerrada.',
                    { tag: 'test' }
                );
                break;

            case 'GET_STATUS': {
                const alarmas    = await idbGet('finanzas_alarmas') || [];
                const pendientes = alarmas.filter(a => !a.disparada);
                responder({
                    type:       'STATUS_RESPONSE',
                    total:      alarmas.length,
                    pendientes: pendientes.length,
                    alarmas
                });
                break;
            }

            case 'CLEAR_SCHEDULE':
                await idbSet('finanzas_alarmas', []);
                responder({ type: 'SCHEDULE_CLEARED' });
                break;
        }
    })();

    // Extender vida del SW si el evento lo soporta (ExtendableMessageEvent)
    if (typeof e.waitUntil === 'function') {
        e.waitUntil(tarea);
    }
});

// ── CLIC EN NOTIFICACIÓN ─────────────────────────────────────
self.addEventListener('notificationclick', e => {
    e.notification.close();

    if (e.action === 'close') return;

    e.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            for (const c of clients) {
                if (c.url.includes(BASE) && 'focus' in c) return c.focus();
            }
            return self.clients.openWindow(BASE);
        })
    );
});

// ============================================================
//  MOTOR DE ALARMAS — persiste en IndexedDB
// ============================================================

async function guardarYProgramarTodo(payload) {
    await idbSet('finanzas_snapshot', payload);

    const alarmas = construirAlarmas(payload);
    await idbSet('finanzas_alarmas', alarmas);

    await programarConTriggers(alarmas);
    await verificarAlarmasPendientes();
}

function construirAlarmas(payload) {
    const alarmas = [];
    const ahora   = Date.now();
    const hoy     = new Date();
    const diaHoy  = hoy.getDate();
    const msDia   = 24 * 60 * 60 * 1000;

    const {
        fixedExpenses   = [],
        fixedIncomes    = [],
        savingsGoals    = [],
        disponible      = 0,
        presupuesto     = 0,
        gastosMes       = 0,
        ingresosMes     = 0,
        fixedPendientes = 0,
        metasActivas    = 0,
        libreParaGastar = 0,
        diasRestantes   = 0
    } = payload;

    // ── 1. RESUMEN DIARIO — 8:30 AM ──────────────────────────
    const resumen8am = tsHoy(8, 30, hoy);
    const tsResumen  = resumen8am > ahora ? resumen8am : resumen8am + msDia;

    const limiteDiario    = diasRestantes > 0 ? Math.max(0, libreParaGastar / diasRestantes) : 0;
    const disponibleFmt   = formatNum(disponible);
    const limiteDiarioFmt = formatNum(limiteDiario);

    const resumenBody = disponible > 0
        ? `Disponible: $${disponibleFmt} | Gastos del mes: $${formatNum(gastosMes)} | Fijos pendientes: ${fixedPendientes} | Metas: ${metasActivas}\nHoy puedes gastar hasta: $${limiteDiarioFmt}`
        : `⚠️ Sin margen disponible — revisa tus finanzas | Fijos pendientes: ${fixedPendientes} | Metas: ${metasActivas}`;

    alarmas.push({
        id:         'resumen-diario',
        titulo:     `✅ Resumen financiero — ${nombreDia(tsResumen)}`,
        cuerpo:     resumenBody,
        timestamp:  tsResumen,
        tag:        'resumen-diario',
        disparada:  false,
        recurrente: true,
        intervalo:  msDia
    });

    // ── 2. RECORDATORIO CIERRE DÍA — 7:00 PM ─────────────────
    const ts7pm      = tsHoy(19, 0, hoy);
    const ts7pmFinal = ts7pm > ahora ? ts7pm : ts7pm + msDia;

    alarmas.push({
        id:         'cierre-dia',
        titulo:     '📝 ¿Registraste todo hoy?',
        cuerpo:     '¿Hiciste algún pago en efectivo, transferencia o compra que no registraste en la app? Hazlo ahora antes de que se te olvide.',
        timestamp:  ts7pmFinal,
        tag:        'cierre-dia',
        disparada:  false,
        recurrente: true,
        intervalo:  msDia
    });

    // ── 3. GASTOS FIJOS ───────────────────────────────────────
    // CORRECCIÓN: si paymentDay ya pasó este mes, diasRestantesGasto
    // sería negativo → lo ajustamos al mes siguiente.
    fixedExpenses.filter(f => f.status === 'pending').forEach(gasto => {
        let diasRestantesGasto = gasto.paymentDay - diaHoy;

        if (diasRestantesGasto < 0) {
            const diasEnMesActual = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
            diasRestantesGasto    = diasRestantesGasto + diasEnMesActual;
        }

        // 3 días antes — 9:00 AM
        if (diasRestantesGasto >= 3) {
            const ts = tsEnDias(diasRestantesGasto - 3, 9, 0, hoy);
            if (ts > ahora) alarmas.push({
                id:        `gasto-3d-${slugify(gasto.name)}`,
                titulo:    '📌 Gasto fijo en 3 días',
                cuerpo:    `"${gasto.name}" vence el día ${gasto.paymentDay}. Valor: $${formatNum(gasto.amount)}`,
                timestamp: ts,
                tag:       `gasto-3d-${slugify(gasto.name)}`,
                disparada: false
            });
        }

        // 1 día antes — 9:00 AM
        if (diasRestantesGasto >= 1) {
            const ts = tsEnDias(diasRestantesGasto - 1, 9, 0, hoy);
            if (ts > ahora) alarmas.push({
                id:        `gasto-1d-${slugify(gasto.name)}`,
                titulo:    '⚠️ Gasto fijo mañana',
                cuerpo:    `"${gasto.name}" vence MAÑANA. Asegúrate de tener $${formatNum(gasto.amount)} disponible.`,
                timestamp: ts,
                tag:       `gasto-1d-${slugify(gasto.name)}`,
                disparada: false
            });
        }

        // El mismo día — 8:30 AM
        if (diasRestantesGasto === 0) {
            const ts = tsHoy(8, 30, hoy);
            if (ts > ahora) alarmas.push({
                id:        `gasto-hoy-${slugify(gasto.name)}`,
                titulo:    '🚨 Pago HOY',
                cuerpo:    `"${gasto.name}" vence HOY. Valor: $${formatNum(gasto.amount)}. Márcalo como pagado en la app.`,
                timestamp: ts,
                tag:       `gasto-hoy-${slugify(gasto.name)}`,
                disparada: false
            });
        }
    });

    // ── 4. INGRESOS FIJOS ─────────────────────────────────────
    fixedIncomes.filter(f => f.status === 'pending').forEach(ingreso => {
        let dias = ingreso.paymentDay - diaHoy;

        if (dias < 0) {
            const diasEnMesActual = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
            dias = dias + diasEnMesActual;
        }

        // 1 día antes — 9:00 AM
        if (dias >= 1) {
            const ts = tsEnDias(dias - 1, 9, 0, hoy);
            if (ts > ahora) alarmas.push({
                id:        `ingreso-1d-${slugify(ingreso.name)}`,
                titulo:    '💵 Ingreso mañana',
                cuerpo:    `"${ingreso.name}" se recibe MAÑANA. Valor esperado: $${formatNum(ingreso.amount)}`,
                timestamp: ts,
                tag:       `ingreso-1d-${slugify(ingreso.name)}`,
                disparada: false
            });
        }

        // El mismo día — 8:30 AM
        if (dias === 0) {
            const ts = tsHoy(8, 30, hoy);
            if (ts > ahora) alarmas.push({
                id:        `ingreso-hoy-${slugify(ingreso.name)}`,
                titulo:    '💰 Ingreso esperado HOY',
                cuerpo:    `"${ingreso.name}" debería llegar HOY. $${formatNum(ingreso.amount)}. Márcalo como recibido.`,
                timestamp: ts,
                tag:       `ingreso-hoy-${slugify(ingreso.name)}`,
                disparada: false
            });
        }
    });

    // ── 5. METAS DE AHORRO ────────────────────────────────────
    savingsGoals.forEach(meta => {
        if (!meta.date) return;
        const fechaMeta    = new Date(meta.date + 'T00:00:00').getTime();
        const diasParaMeta = Math.ceil((fechaMeta - ahora) / msDia);
        const progreso     = meta.amount > 0 ? (meta.current / meta.amount) * 100 : 0;

        if (diasParaMeta === 7 && progreso < 100) {
            const ts = tsEnDias(0, 10, 0, hoy);
            if (ts > ahora) alarmas.push({
                id:        `meta-7d-${slugify(meta.name)}`,
                titulo:    '🎯 Meta próxima a vencer',
                cuerpo:    `"${meta.name}" vence en 7 días. Progreso: ${progreso.toFixed(0)}% ($${formatNum(meta.current)} de $${formatNum(meta.amount)})`,
                timestamp: ts,
                tag:       `meta-7d-${slugify(meta.name)}`,
                disparada: false
            });
        }

        if (diasParaMeta === 1 && progreso < 100) {
            const ts = tsEnDias(0, 9, 0, hoy);
            if (ts > ahora) alarmas.push({
                id:        `meta-1d-${slugify(meta.name)}`,
                titulo:    '⏰ Meta vence mañana',
                cuerpo:    `"${meta.name}" vence MAÑANA y solo llevas el ${progreso.toFixed(0)}%. Faltan $${formatNum(meta.amount - meta.current)}.`,
                timestamp: ts,
                tag:       `meta-1d-${slugify(meta.name)}`,
                disparada: false
            });
        }
    });

    // ── 6. BALANCE CRÍTICO / ADVERTENCIA ─────────────────────
    // CORRECCIÓN: programado a las 9:05 AM (no ahora + 5s) para evitar
    // spam cada vez que la app se abre. Solo se añade si aún no pasó esa hora.
    if (presupuesto > 0) {
        const pct      = ((presupuesto - disponible) / presupuesto) * 100;
        const tsAlerta = tsHoy(9, 5, hoy);

        if (pct >= 90 && tsAlerta > ahora) {
            alarmas.push({
                id:         'balance-critico',
                titulo:     '🚨 Balance Crítico',
                cuerpo:     `Has usado el ${pct.toFixed(0)}% de tu presupuesto. Solo te quedan $${formatNum(disponible)} disponibles.`,
                timestamp:  tsAlerta,
                tag:        'balance-critico',
                disparada:  false,
                soloUnaVez: true
            });
        } else if (pct >= 75 && pct < 90 && tsAlerta > ahora) {
            alarmas.push({
                id:         'balance-advertencia',
                titulo:     '⚠️ Presupuesto al 75%',
                cuerpo:     `Llevas el ${pct.toFixed(0)}% del presupuesto usado. Disponible restante: $${formatNum(disponible)}.`,
                timestamp:  tsAlerta,
                tag:        'balance-advertencia',
                disparada:  false,
                soloUnaVez: true
            });
        }
    }

    return alarmas;
}

// ── Notification Triggers API (donde esté soportada) ─────────
async function programarConTriggers(alarmas) {
    if (!('showTrigger' in Notification.prototype)) return;

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
            console.warn('[SW] Trigger falló para', a.id, err.message);
        }
    }
}

// ── Verificar alarmas pendientes (fallback universal) ─────────
async function verificarAlarmasPendientes() {
    const alarmas = await idbGet('finanzas_alarmas');
    if (!alarmas || !alarmas.length) return;

    const ahora   = Date.now();
    let   cambios = false;

    for (const a of alarmas) {
        if (a.disparada)         continue;
        if (a.timestamp > ahora) continue;

        await mostrarNotificacion(a.titulo, a.cuerpo, {
            tag:      a.tag,
            renotify: !!a.recurrente
        });

        if (a.recurrente && a.intervalo) {
            // Avanzar al siguiente ciclo futuro
            while (a.timestamp <= ahora) a.timestamp += a.intervalo;

            // CORRECCIÓN: re-registrar Trigger para el nuevo timestamp
            if ('showTrigger' in Notification.prototype) {
                try {
                    await self.registration.showNotification(a.titulo, {
                        body:        a.cuerpo,
                        tag:         a.tag,
                        icon:        BASE + 'icon-192.png',
                        badge:       BASE + 'icon-192.png',
                        vibrate:     [200, 100, 200],
                        showTrigger: new TimestampTrigger(a.timestamp)
                    });
                } catch {}
            }
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
        body:               cuerpo,
        icon:               BASE + 'icon-192.png',
        badge:              BASE + 'icon-192.png',
        vibrate:            [200, 100, 200],
        requireInteraction: false,
        ...opts
    });
}

// ── Helpers de tiempo ─────────────────────────────────────────
function tsHoy(h, m, ref) {
    return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h, m, 0).getTime();
}

function tsEnDias(dias, h, m, ref) {
    return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + dias, h, m, 0).getTime();
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

// ============================================================
//  INDEXEDDB — Conexión singleton
//  CORRECCIÓN: se reutiliza una única promesa de apertura para
//  evitar conflictos cuando idbGet/idbSet se llaman en paralelo.
// ============================================================

let _dbPromise = null;

function getDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((res, rej) => {
        const r = indexedDB.open('finanzas_sw_db', 1);
        r.onupgradeneeded = () => {
            if (!r.result.objectStoreNames.contains('kv')) {
                r.result.createObjectStore('kv');
            }
        };
        r.onsuccess = () => res(r.result);
        r.onerror   = () => {
            _dbPromise = null;  // permitir reintento en el siguiente ciclo
            rej(r.error);
        };
    });
    return _dbPromise;
}

function idbSet(key, value) {
    return getDB().then(db => new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = res;
        tx.onerror    = () => rej(tx.error);
    }));
}

function idbGet(key) {
    return getDB().then(db => new Promise((res, rej) => {
        const tx  = db.transaction('kv', 'readonly');
        const req = tx.objectStore('kv').get(key);
        req.onsuccess = () => res(req.result ?? null);
        req.onerror   = () => rej(req.error);
    }));
}