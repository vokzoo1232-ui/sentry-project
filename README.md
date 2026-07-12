# 🛡️ Sentry - Classroom Management System

> Built by me yeah im not leaking my name & friends at 4am. Powered by Monster Energy.

## 🚀 What is this?

Sentry is a lightweight, self-hosted classroom monitoring system. It lets teachers:

- 👀 See what students are browsing in real-time
- 🚫 Block websites (blacklist/whitelist)
- 📊 View student activity logs
- 👥 Manage multiple teachers and students

**Not spyware. Just a tool for schools that don't want to pay $10,000/year for the same thing.**

---

## 🏗️ Architecture
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Chrome │ │ │ │ │
│ Extension │ ──► │ Backend API │ ──► │ PostgreSQL │
│ (student) │ │ (Render) │ │ (Neon) │
└─────────────────┘ └─────────────────┘ └─────────────────┘
▲ ▲
│ │
┌─────────────────┐ ┌─────────────────┐
│ Dashboard │ │ Teachers │
│ (Vercel) │ ◄── │ Login here │
└─────────────────┘ └─────────────────┘

## 🛠️ Tech Stack

- **Frontend:** HTML/CSS/JS (Vanilla, because we're built different)
- **Backend:** Node.js + Express
- **Database:** PostgreSQL (Neon)
- **Auth:** JWT + bcrypt
- **Hosting:** Render (backend) + Vercel (frontend)
- **Daemon:** C++ (for the real ones)

---

## 📁 Project Structure
sentry-project/
├── frontend/
│ └── index.html # Teacher dashboard
├── backend/
│ ├── server.js # Main API
│ └── rule_engine.js # Rule processing
├── daemon/
│ └── daemon.cpp # C++ student agent
├── database/
│ └── schema.sql # PostgreSQL schema
├── deploy.sh # One-click deployment
└── README.md # This file

text

---

## 🚀 Quick Start

### 1️⃣ Clone the repo
git clone https://github.com/vokzoo1232-ui/sentry-project.git
cd sentry-project
2️⃣ Set up environment variables
bash
cp .env.example .env
# Add your DATABASE_URL, JWT_SECRET, etc.
3️⃣ Deploy backend (Render)
Connect your GitHub repo

Set environment variables

Deploy

4️⃣ Deploy frontend (Vercel)
Import the repo

Deploy

5️⃣ Login
Email: admin@school.com

Password: password123

🔧 API Endpoints
Method	Endpoint	Description
POST	/api/auth/login	Teacher login
GET	/api/schools/:id/students	Get all students
GET	/api/schools/:id/rules	Get all rules
POST	/api/schools/:id/rules	Create a rule
DELETE	/api/schools/:id/rules/:id	Delete a rule
POST	/api/schools/:id/logs	Upload student logs
GET	/api/schools/:id/logs	Get logs
🧪 Testing
bash
# Test health
curl https://sentry-project-1.onrender.com/health

# Test login
curl -X POST https://sentry-project-1.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@school.com","password":"password123"}'
🏆 Built By
Your Name - C++ Daemon, Deployment

Friend 1 - Backend API

Friend 2 - Frontend Dashboard

Friend 3 - Rule Engine

Built at 4am with Monster Energy and questionable life choices.

⚠️ Disclaimer
This was built as a school project by 16-year-olds. It's not enterprise-grade, but it works. Use at your own risk. Don't be evil.

📄 License
MIT - Do whatever you want with it. Just don't blame us if your school bans you.
