# 🎯 Kannada Speech Assessment Tool

A full-stack web application for assessing speech development in Kannada-speaking children using SODA (Schedule of Developing Articulation) analysis.

## Running locally (Docker)

Quick local run using Docker (recommended):

1. Ensure you have Docker and Docker Compose installed.
2. Copy or create a `.env` file at the project root (you already added one).
3. Build and run both services:

```bash
docker-compose up --build
```

This will start:

- `web` (Node backend + frontend) on http://localhost:3000
- `python` (Flask SODA service) on http://localhost:5000

The Node backend is configured to call the Python service at `http://python:5000` when running via Docker Compose. Locally (without containers) ensure `PYTHON_BACKEND_URL` in your `.env` points to `http://localhost:5000`.

To stop:

```bash
docker-compose down
```
