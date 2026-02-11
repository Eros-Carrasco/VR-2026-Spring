import asyncio
import cv2
import numpy as np
import json
from fastapi import FastAPI, WebSocket
from ultralytics import RTDETR

app = FastAPI()

# --- CONFIGURACIÓN ---
MODEL_NAME = 'rtdetr-l.pt'
CONFIDENCE_THRESHOLD = 0.55
# Objetos VIP: Persona, Botella, Taza, Silla, Laptop, Celular
TARGET_CLASSES = [0, 39, 41, 56, 63, 67]

# Resolución deseada (Debe coincidir con lo que espera tu JS: 1280x720)
CAMERA_WIDTH = 1280
CAMERA_HEIGHT = 720

print(f"👁️  Cargando modelo {MODEL_NAME}...")
try:
    model = RTDETR(MODEL_NAME)
    print("✅ Modelo cargado.")
except Exception as e:
    print(f"❌ Error modelo: {e}")
    exit()

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print("🔗 Cliente Web conectado.")

    # --- CAMBIO IMPORTANTE: Usar Webcam (ID 0) ---
    cap = cv2.VideoCapture(0)
    
    # Forzamos la resolución de la cámara para que coincida con el JS
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAMERA_WIDTH)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAMERA_HEIGHT)

    if not cap.isOpened():
        print("❌ ERROR CRÍTICO: No se puede abrir la cámara.")
        print("💡 PISTA: Cierra Zoom, Teams o recarga la página web si está usando la cámara.")
        return

    try:
        while True:
            # 1. Leer directo de la cámara
            ret, frame = cap.read()
            if not ret:
                print("⚠️ No se pudo leer el frame de la cámara.")
                break

            # (Opcional) Espejo: Voltea la imagen para que se sienta natural
            frame = cv2.flip(frame, 1)

            # 2. Inferencia
            results = model.predict(frame, conf=CONFIDENCE_THRESHOLD, classes=TARGET_CLASSES, verbose=False)
            
            detections = []
            
            # 3. Procesar
            for r in results:
                boxes = r.boxes
                for box in boxes:
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    cls_id = int(box.cls[0])
                    label = r.names[cls_id]
                    
                    detections.append({
                        "label": label,
                        "bbox": [x1, y1, x2, y2]
                    })

            # 4. Debug en PC (Verás tu cara aquí)
            annotated_frame = results[0].plot()
            cv2.imshow("Vision Server - WEBCAM MODE", annotated_frame)
            
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

            # 5. Enviar al navegador
            if len(detections) > 0:
                await websocket.send_text(json.dumps(detections))
            
            await asyncio.sleep(0.01)

    except Exception as e:
        print(f"⚠️ Error: {e}")
    finally:
        cap.release() # Soltar la cámara al terminar
        cv2.destroyAllWindows()
        print("🔒 Cámara liberada.")