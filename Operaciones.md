PROMPT DE INTEGRACIÓN — Agent Operations 777
Archivo fuente: agent_operations__777_.csv
Período cubierto: 2026-03-31 al 2026-04-12 (13 días)
Total de registros: 6.354 operaciones
Columnas: 6 (A hasta F)

ADVERTENCIA DE FORMATO — LEER PRIMERO
El archivo tiene un header especial en la línea 1 que dice literalmente sep=, — esto es un artefacto de exportación de Excel/Google Sheets. Los encabezados reales están en la línea 2 y los datos empiezan en la línea 3.
LÍNEA 1 → sep=,         ← IGNORAR, es metadata del exportador
LÍNEA 2 → Fecha,Estado,Cantidad,Tipo,Alias,Balance   ← encabezados reales
LÍNEAS 3–6.356 → datos de operaciones
Al importar: usar skiprows=1 (Python/pandas) o equivalente en la app destino.

MAPA DE COLUMNAS
ColumnaLetraNombre exactoTipo de datoDescripciónEjemplo1AFechaTexto → DateTimeFecha y hora exacta de la operación2026-04-12 08:35:202BEstadoTextoEstado de la operaciónDONE (único valor, todas confirmadas)3CCantidadNumérico floatMonto de la operación. Positivo = ingreso. Negativo = egreso/retiro5000, -370004DTipoTextoCategoría de la operación (ver tabla de tipos abajo)Deposito de un jugador5EAliasTextoNombre de usuario del jugador o agente involucradonor1749, donplata6FBalanceNumérico floatBalance acumulado del agente después de esa operación8536693.96

LÓGICA DE CLASIFICACIÓN DE OPERACIONES
No existe una columna explícita de "tipo de movimiento" (carga/retiro). La diferenciación se hace combinando la columna Tipo y el signo de Cantidad:
Regla de clasificación:
SI Tipo == "Te cargaron"
    → RECARGA_AGENTE  (el agente recibe saldo del sistema/casa)

SI Tipo == "Bono jugador"
    → BONO            (bonificación acreditada a un jugador)

SI Tipo == "Deposito de un jugador" AND Cantidad > 0
    → CARGA           (jugador deposita / carga fichas con el agente)

SI Tipo == "Deposito de un jugador" AND Cantidad < 0
    → RETIRO          (jugador retira fichas del agente)
Conteo y volumen por tipo clasificado:
Tipo clasificadoOperacionesVolumen totalCARGA5.870+$118.009.966RETIRO442-$30.702.050BONO36+$177.645RECARGA_AGENTE6+$45.999.901

Nota: RECARGA_AGENTE corresponde a recargas del sistema al agente (montos muy grandes: entre $999.901 y $15.000.000). El alias en esos registros es donplata (6 operaciones, $46M en total) — identificar si es un agente superior o cuenta del sistema.


TIPOS DE OPERACIÓN (columna D — valores únicos)
Valor en columna DCantidadDescripción operativaDeposito de un jugador6.312Movimiento entre jugador y agente. Positivo = carga, negativo = retiroBono jugador36Bonificación otorgada. Siempre positivoTe cargaron6El agente recibe saldo. Siempre positivo. Montos grandes

DISTRIBUCIÓN HORARIA DE OPERACIONES
Datos clave para entender patrones de actividad:
HoraOperaciones totalesVolumen neto00hs512$3.380.70201hs358$105.441 ⚠️ pico de retiros (40 retiros)02hs226$7.365.36603hs158-$349.463 ⚠️ único horario con neto negativo04hs122$687.49005hs97$1.320.41006hs97$615.82007hs127$987.13008hs148$830.68609hs151$1.033.62110hs162$2.901.90911hs167$1.082.90712hs204$1.667.84213hs250$1.570.79014hs313$7.183.86115hs359$2.669.10716hs280$23.205.235 🔝 mayor volumen del día17hs288$2.300.23518hs264$1.390.13219hs323$1.935.64020hs344$1.400.28821hs407$17.627.64522hs470$3.581.62223hs527$2.813.500 🔝 mayor cantidad de operaciones
Hora pico de CARGAS: 23hs (494 operaciones de carga)
Hora pico de RETIROS: 01hs (40 operaciones de retiro)
Franja de mayor volumen económico: 16hs y 21hs

VOLUMEN DIARIO (CARGAS vs RETIROS)
FechaCargas (ops)Total cargasRetiros (ops)Total retirosBonosRecarga agente2026-03-31130$1.617.9907-$742.000——2026-04-01483$9.423.00137-$2.325.3191$20.000.0002026-04-02573$7.497.15238-$1.954.8001—2026-04-03488$5.264.06151-$2.609.1504—2026-04-04480$5.153.74232-$1.891.5005—2026-04-05430$4.284.49337-$2.090.0101$5.000.0002026-04-06418$4.559.75635-$2.320.40016—2026-04-07457$4.686.53335-$2.865.500—$10.999.9012026-04-08539$5.876.50531-$3.051.0002—2026-04-09481$6.278.38434-$2.825.8001—2026-04-10581$7.387.14149-$4.321.5712—2026-04-11608$7.283.84734-$2.397.0003$10.000.0002026-04-12202$2.519.81522-$1.308.000——

Nota 04-12: el día está incompleto (datos hasta las 08:35hs).


TOP 10 USUARIOS POR VOLUMEN MOVIDO
AliasOperacionesVolumen totalPromedio por opdonplata6$45.999.901$7.666.650miño309614$3.975.000$283.929ferna8054$2.037.530$37.732liiz092444$1.075.100$24.434casl765534$1.008.500$29.662Valeria36963$973.360$15.450po276747$899.350$19.135mariel067113$721.800$55.523toobi888010$708.000$70.80064cari18$677.000$37.611

BALANCE DEL AGENTE
PuntoValorBalance inicial (2026-03-31 21:02)$3.839.807,96Balance final (2026-04-12 08:35)$8.536.693,96Variación neta en el período+$4.696.886

CAMPOS DERIVADOS SUGERIDOS PARA LA APP DESTINO
Al importar, se recomienda que la aplicación genere/calcule estos campos derivados:
operacion_tipo   = clasificación CARGA / RETIRO / BONO / RECARGA_AGENTE (ver regla arriba)
fecha_date       = solo la fecha sin hora (para agrupación diaria)
hora             = solo la hora (para agrupación horaria)
dia_semana       = lunes/martes/etc. (para análisis de patrones semanales)
monto_absoluto   = abs(Cantidad) (para filtros de monto sin importar signo)

EJEMPLO DE PRIMERAS FILAS (para validar importación)
Fecha                | Estado | Cantidad  | Tipo                    | Alias    | Balance
2026-04-12 08:35:20  | DONE   | 5000      | Deposito de un jugador  | nor1749  | 8536693.96   → CARGA
2026-04-12 08:23:52  | DONE   | 5000      | Deposito de un jugador  | alba6741 | 8541693.96   → CARGA
2026-04-12 08:15:57  | DONE   | -15000    | Deposito de un jugador  | rosana8651 | ...         → RETIRO
2026-04-12 08:15:37  | DONE   | -37000    | Deposito de un jugador  | rrosa20  | ...          → RETIRO