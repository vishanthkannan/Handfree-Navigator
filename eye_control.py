import cv2
import mediapipe as mp
import numpy as np
import pyautogui
import time

# ========== CONFIG ==========
EAR_THRESH = 0.22          # Blink detection threshold
DOUBLE_BLINK_TIME = 0.4    # Max seconds between blinks for double click
SMOOTHING = 0.6            # Higher smoothing = less jitter
BASE_DEADZONE = 3          # Minimum deadzone
MAX_DEADZONE = 10          # Maximum deadzone when very still
MARGIN = 5                 # Margin for all edges
FREEZE_TIME = 0.25         # Time to freeze mouse after click (seconds)
CAM_INDEX = 0
# ============================

pyautogui.FAILSAFE = False

mp_face_mesh = mp.solutions.face_mesh
face_mesh = mp_face_mesh.FaceMesh(max_num_faces=1, refine_landmarks=True)

# Landmark indices
LEFT_EYE = [33, 160, 158, 133, 153, 144]
RIGHT_EYE = [362, 385, 387, 263, 373, 380]
LEFT_IRIS = [474, 475, 476, 477]
RIGHT_IRIS = [469, 470, 471, 472]

screen_w, screen_h = pyautogui.size()
prev_x, prev_y = pyautogui.position()

last_blink_time = 0
eye_closed = False
freeze_until = 0

def euclid(a, b):
    return np.linalg.norm(a - b)

def eye_aspect_ratio(eye_pts):
    A = euclid(eye_pts[1], eye_pts[5])
    B = euclid(eye_pts[2], eye_pts[4])
    C = euclid(eye_pts[0], eye_pts[3])
    return (A + B) / (2.0 * C)

cap = cv2.VideoCapture(CAM_INDEX)

print("Press 'q' to quit.")
while cap.isOpened():
    ret, frame = cap.read()
    if not ret:
        break

    frame = cv2.flip(frame, 1)
    h, w, _ = frame.shape
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = face_mesh.process(rgb)

    if results.multi_face_landmarks:
        lm = results.multi_face_landmarks[0].landmark

        # Iris centers
        left_iris = np.array([(lm[i].x * w, lm[i].y * h) for i in LEFT_IRIS])
        right_iris = np.array([(lm[i].x * w, lm[i].y * h) for i in RIGHT_IRIS])

        left_center = left_iris.mean(axis=0)
        right_center = right_iris.mean(axis=0)
        gaze = (left_center + right_center) / 2

        # Eye corners for normalization
        left_eye_pts = np.array([(lm[i].x * w, lm[i].y * h) for i in LEFT_EYE])
        right_eye_pts = np.array([(lm[i].x * w, lm[i].y * h) for i in RIGHT_EYE])

        eye_width = euclid(left_eye_pts[0], left_eye_pts[3]) + euclid(right_eye_pts[0], right_eye_pts[3])
        eye_height = (euclid(left_eye_pts[1], left_eye_pts[5]) + euclid(right_eye_pts[1], right_eye_pts[5])) / 2

        # Normalize to screen coords
        norm_x = (gaze[0] - w / 2) / (eye_width * 2)
        norm_y = (gaze[1] - h / 2) / (eye_height * 4)

        # Apply margin to all sides
        target_x = np.clip(screen_w / 2 + norm_x * screen_w, MARGIN, screen_w - MARGIN)
        target_y = np.clip(screen_h / 2 + norm_y * screen_h, MARGIN, screen_h - MARGIN)

        # EAR for blink detection
        ear_left = eye_aspect_ratio(left_eye_pts)
        ear_right = eye_aspect_ratio(right_eye_pts)
        both_closed = (ear_left < EAR_THRESH) and (ear_right < EAR_THRESH)

        now = time.time()

        # Blink logic
        if both_closed and not eye_closed:
            eye_closed = True
            blink_time = now

            # Freeze mouse during click to prevent jiggle
            freeze_until = now + FREEZE_TIME

            if blink_time - last_blink_time < DOUBLE_BLINK_TIME:
                pyautogui.doubleClick()
                print("Double click")
                last_blink_time = 0
            else:
                pyautogui.click()
                print("Single click")
                last_blink_time = blink_time

        elif not both_closed:
            eye_closed = False
            if now > freeze_until:  # Only move if not frozen
                dx = target_x - prev_x
                dy = target_y - prev_y

                # Adaptive deadzone based on eye movement
                movement_amount = np.hypot(dx, dy)
                adaptive_deadzone = np.clip(
                    BASE_DEADZONE + (MAX_DEADZONE - BASE_DEADZONE) * (1 - movement_amount / 50),
                    BASE_DEADZONE, MAX_DEADZONE
                )

                if movement_amount > adaptive_deadzone:
                    cur_x = prev_x + SMOOTHING * dx
                    cur_y = prev_y + SMOOTHING * dy
                    pyautogui.moveTo(cur_x, cur_y, _pause=False)
                    prev_x, prev_y = cur_x, cur_y

        # Debug markers
        cv2.circle(frame, tuple(np.int32(left_center)), 3, (0, 255, 255), -1)
        cv2.circle(frame, tuple(np.int32(right_center)), 3, (0, 255, 255), -1)

    cv2.imshow("Eye Control", frame)
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()