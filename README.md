# 🌊 FloodWise

> **Smart Urban Waterlogging Prediction & Safe Routing Copilot**

FloodWise is an intelligent application designed to predict street-level waterlogging and urban flooding risks in real-time, helping commuters and city dwellers navigate safely through better, flood-aware routing. Built to combat urban monsoon disruptions, FloodWise integrates predictive machine learning models with dynamic mapping tools to provide risk probabilities and safer alternative routes.

---

## 🚀 Key Features

* **Street-Level Risk Probability:** Evaluates terrain, rain intensity, drainage quality, and historical data to output precise waterlogging risk percentages and confidence scores.
* **AI-Powered Model Inference:** Supports flexible deployment modes—including local/on-device estimation and remote API integration with custom-trained machine learning pipelines.
* **Smart Routing & Navigation:** Suggests safer travel directions that bypass high-risk waterlogged zones.
* **Interactive What-If Simulator:** Allows users to test and explore flood risks under varying rainfall scenarios.
* **Cross-Platform Accessibility:** Available as both a mobile application and a companion web platform.

---

## 🛠️ Tech Stack

* **Mobile App:** Built with modern cross-platform frameworks, supporting OpenStreetMap (OSM) and Google Maps API for geocoding and directions.
* **Backend & ML Pipeline:** Python, FastAPI, Pandas, NumPy, and machine learning runtimes (TFLite/ONNX).
* **Mapping & Search:** OpenStreetMap (Nominatim) / Google Places & Directions APIs.

---

## 🌐 Companion Website

Check out our web platform and project portal here:  
👉 Mobile App Drive Download Link: https://drive.google.com/file/d/1QWbktj0gSTrI6I_FTG16aNdzWRKJtbBc/view?usp=sharing

---

## ⚙️ Configuration & Setup

### 1. Backend API Configuration
If you are running the backend prediction service locally or via cloud deployment (e.g., Render):
* Set your model mode to **Remote API** in the app settings.
* Provide your deployed endpoint URL (e.g., https://52-65-180-152.nip.io/docs).

### 2. Map Provider Setup
FloodWise supports dual map configurations:
* **Free Maps:** Uses OpenStreetMap tiles and Nominatim search out of the box with zero configuration.
* **Google Maps:** Configure your Google Maps API key with **Places API** and **Directions API** enabled to leverage Google's search and routing capabilities.

---

## 👥 Contributors

Developed with ❤️ by Krishna Yadav, Shashank Kumar, Rohit Kumar Singh and Shubham Aggarwal.
