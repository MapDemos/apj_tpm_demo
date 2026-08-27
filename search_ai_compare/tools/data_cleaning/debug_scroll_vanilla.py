#!/usr/bin/env python3
"""
CustomTkinter/ttkを一切使わない、素のtkinter.Frameだけでのトラックパッド
MouseWheel到達テスト。debug_scroll_live.pyの追加切り分け用。

使い方:
  python3 debug_scroll_vanilla.py

ウィンドウ内の灰色エリア（plain tk.Frame）にカーソルを置いてトラックパッドで
縦スワイプしてみてください。ターミナルに "plain tk.Frame: MouseWheel!" が
出るかどうかを見てください。
"""
import tkinter as tk

root = tk.Tk()
root.title("vanilla scroll test")
root.geometry("500x400")

label = tk.Label(root, text="ここでトラックパッドを縦スワイプしてみてください", bg="#dddddd", height=20)
label.pack(fill="both", expand=True, padx=20, pady=20)

canvas = tk.Canvas(root, bg="#333333", height=80)
canvas.pack(fill="x", padx=20, pady=(0, 20))
canvas.create_text(250, 40, text="こっち(素のCanvas)でも試してみてください", fill="white")


def on_wheel_label(event):
    print(f"plain tk.Frame(Label): MouseWheel! delta={event.delta}")


def on_wheel_canvas(event):
    print(f"plain tk.Canvas: MouseWheel! delta={event.delta}")


root.bind_all("<MouseWheel>", lambda e: print(f"[bind_all] widget={e.widget} class={type(e.widget).__name__} delta={e.delta}"))
label.bind("<MouseWheel>", on_wheel_label)
canvas.bind("<MouseWheel>", on_wheel_canvas)

root.mainloop()
