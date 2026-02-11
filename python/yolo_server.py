import asyncio
import cv2
import numpy as np
import json
import mss
from fastapi import FastAPI, WebSocket
from ultralytics import YOLO

app = FastAPI()
model = YOLO('yolov8x.pt') 

# --- CONFIGURACIÓN ---
MODO_TESTING = True  # <--- CAMBIA ESTO A False CUANDO USES EL VISOR

# Área de captura (Solo se usa si MODO_TESTING = False)
monitor = {"top": 100, "left": 100, "width": 1280, "height": 720}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    print(f"Cliente conectado. Modo Testing: {MODO_TESTING}")

    # Si estamos en modo testing, abrimos la cámara
    cap = None
    if MODO_TESTING:
        cap = cv2.VideoCapture(0) # 0 suele ser la webcam principal

    try:
        with mss.mss() as sct:
            while True:
                # --- A. OBTENER IMAGEN ---
                if MODO_TESTING:
                    ret, frame = cap.read()
                    if not ret:
                        break
                else:
                    # Modo Casting (Captura de pantalla)
                    img = np.array(sct.grab(monitor))
                    frame = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)

                # --- B. DETECCIÓN YOLO ---
                results = model(frame, verbose=False)
                
                detections = []
                # Preparamos la imagen para mostrarla en tu PC (Debug)
                annotated_frame = results[0].plot() 

                for r in results:
                    boxes = r.boxes
                    for box in boxes:
                        x1, y1, x2, y2 = box.xyxy[0].tolist()
                        conf = float(box.conf[0])
                        cls = int(box.cls[0])
                        label = model.names[cls]

                        if conf > 0.5:
                            detections.append({
                                "label": label,
                                "bbox": [x1, y1, x2, y2]
                            })

                # --- C. VISUALIZACIÓN EN PC (¡Importante para testing!) ---
                # Esto abrirá una ventanita en tu compu para que veas lo que ve YOLO
                cv2.imshow("YOLO Server View", annotated_frame)
                
                # Necesario para que la ventana de CV2 se refresque. 
                # Presiona 'q' en la ventana para salir.
                if cv2.waitKey(1) & 0xFF == ord('q'):
                    break

                # --- D. ENVIAR AL CLIENTE WEB ---
                if len(detections) > 0:
                    await websocket.send_text(json.dumps(detections))
                
                await asyncio.sleep(0.01)

    except Exception as e:
        print(f"Desconexión: {e}")
    finally:
        if cap: cap.release()
        cv2.destroyAllWindows()

# Ejecutar con: uvicorn yolo_server:app --host 0.0.0.0 --port 8000