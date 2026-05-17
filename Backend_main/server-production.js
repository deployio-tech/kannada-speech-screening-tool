// server-production.js - Production-ready version with DB support
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const FormData = require("form-data");
const PDFDocument = require("pdfkit");
const sizeOf = require("image-size");
const connectDB = require("./config/database");
const Child = require("./models/Child");
const { generateToken, verifyToken } = require("./middleware/auth");
const cloudStorage = require("./utils/cloudStorage");

const app = express();
const PORT = process.env.PORT || 3000;
const PYTHON_BACKEND_URL =
  process.env.PYTHON_BACKEND_URL || "http://localhost:5000";
const DATA_PATH = path.join(
  __dirname,
  "..",
  "Frontend_main",
  "assets",
  "data",
  "children.json",
);

// Check if MongoDB is connected
const useDatabase = () => {
  return require("mongoose").connection.readyState === 1;
};

// Optional font paths (add these files to assets/fonts to enable Unicode/IPA)
// In production (Docker), files are at /app/Frontend_main/assets/fonts/
// In development, files are at ../Frontend_main/assets/fonts/
const isProduction = process.env.NODE_ENV === "production";
const assetsPath = isProduction
  ? path.join(__dirname, "..", "Frontend_main", "assets")
  : path.join(__dirname, "..", "Frontend_main", "assets");

const FONT_KANNADA_VAR = path.join(
  assetsPath,
  "fonts",
  "NotoSansKannada-VariableFont_wdth,wght.ttf",
);
const FONT_KANNADA_REG = path.join(
  assetsPath,
  "fonts",
  "NotoSansKannada-Regular.ttf",
);

const FONT_KANNADA = fs.existsSync(FONT_KANNADA_REG)
  ? FONT_KANNADA_REG
  : FONT_KANNADA_VAR;
const FONT_LATIN = path.join(assetsPath, "fonts", "NotoSans-Regular.ttf");

// Summarize SODA results into category counts
function summarizeSODA(results = []) {
  const summary = {
    Correct: 0,
    Substitution: 0,
    Omission: 0,
    Addition: 0,
    Distortion: 0,
  };
  results.forEach((item) => {
    if (item?.error_type === "Distortion") summary.Distortion++;
    else if (item?.error_type === "Substitution") summary.Substitution++;
    else if (item?.error_type === "Omission") summary.Omission++;
    else if (item?.error_type === "Addition") summary.Addition++;
    else summary.Correct++;
  });
  return summary;
}

// Admin credentials (from environment variables)
const ADMIN_CREDENTIALS = {
  username: process.env.ADMIN_USERNAME || "admin",
  password: process.env.ADMIN_PASSWORD || "admin123",
};

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : ["http://localhost:3000", "https://kannada-speech.onrender.com"];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, Postman)
      if (!origin) return callback(null, true);

      if (allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);
// Explicitly handle UTF-8 for Kannada text support
app.use(express.json({ charset: "utf-8" }));
app.use(express.text({ charset: "utf-8" }));
app.use(express.urlencoded({ extended: true, charset: "utf-8" }));
// Set UTF-8 as default response encoding
app.use((req, res, next) => {
  res.charset = "utf-8";
  next();
});

// Setup multer for handling file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Serve static files - adjusted for Docker deployment
// In Docker, frontend files are copied to /app root, not /app/Frontend_main
const frontendPath =
  process.env.NODE_ENV === "production" &&
  !fs.existsSync(path.join(__dirname, "..", "Frontend_main"))
    ? __dirname // Docker: files are in /app
    : path.join(__dirname, "..", "Frontend_main"); // Local: files are in ../Frontend_main

app.use(express.static(frontendPath));

// Start server after attempting MongoDB connection
(async () => {
  // Try to connect to MongoDB
  try {
    await connectDB();
  } catch (err) {
    console.warn("⚠️  MongoDB not available, using JSON fallback");
  }

  app.get("/tts", async (req, res) => {
    try {
      const text = req.query.text;
      const lang = req.query.lang;

      if (!text) {
        return res.status(400).send("Missing 'text' query parameter");
      }

      const encodedText = encodeURIComponent(text);
      const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=${lang || "kn-IN"}&client=tw-ob`;

      const response = await axios.get(ttsUrl, {
        responseType: "arraybuffer",
        headers: {
          "User-Agent": "Mozilla/5.0",
        },
      });

      res.set({
        "Content-Type": "audio/mpeg",
        "Content-Length": response.data.length,
        "Access-Control-Allow-Origin": "*",
      });

      res.send(response.data);
    } catch (err) {
      console.error("TTS Error:", err.message);
      res.status(500).send("Error generating speech");
    }
  });

  // API to get children by age and search (supports both MongoDB and JSON fallback)
  app.get("/api/children", async (req, res) => {
    try {
      const { age, search, gender } = req.query;

      if (useDatabase()) {
        // Use MongoDB
        let query = {};
        if (age) query.age = parseInt(age);
        if (gender) query.gender = new RegExp(`^${gender}$`, "i"); // Case-insensitive gender match
        if (search) {
          query.$or = [
            { name: new RegExp(search, "i") },
            { parent: new RegExp(search, "i") },
            { city: new RegExp(search, "i") },
            { email: new RegExp(search, "i") },
          ];
        }
        const children = await Child.find(query).select("-reports");
        return res.json(children);
      } else {
        // Fallback to JSON with Kannada key support
        let children = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));

        if (age) {
          children = children.filter(
            (child) =>
              String(child["ವಯಸ್ಸು"] || child.age).trim() ===
              String(age).trim(),
          );
        }

        if (search) {
          const s = search.trim().toLowerCase();
          children = children.filter(
            (child) =>
              (child["ಹೆಸರು"] &&
                String(child["ಹೆಸರು"]).toLowerCase().includes(s)) ||
              (child["ಪೋಷಕರು"] &&
                String(child["ಪೋಷಕರು"]).toLowerCase().includes(s)) ||
              (child["ನಗರ"] &&
                String(child["ನಗರ"]).toLowerCase().includes(s)) ||
              (child.name && String(child.name).toLowerCase().includes(s)) ||
              (child.parent &&
                String(child.parent).toLowerCase().includes(s)) ||
              (child.city && String(child.city).toLowerCase().includes(s)),
          );
        }
        return res.json(children);
      }
    } catch (error) {
      console.error("Error fetching children:", error);
      res.status(500).json({ error: "Failed to fetch children" });
    }
  });

  // API to add a new child (supports both MongoDB and JSON fallback)
  app.post("/api/children", async (req, res) => {
    try {
      if (useDatabase()) {
        // Use MongoDB
        const childData = { ...req.body };
        // Ensure phone is always present (even if empty string)
        if (!childData.phone) childData.phone = "";
        // Normalize gender to proper case
        if (childData.gender) {
          const genderLower = childData.gender.toLowerCase();
          if (genderLower === "male") childData.gender = "Male";
          else if (genderLower === "female") childData.gender = "Female";
          else if (genderLower === "other") childData.gender = "Other";
        }
        // Only allow fields defined in schema
        const allowedFields = [
          "name",
          "age",
          "gender",
          "parent",
          "city",
          "email",
          "address",
          "phone",
        ];
        const filteredData = {};
        for (const key of allowedFields) {
          if (childData[key] !== undefined) filteredData[key] = childData[key];
        }
        const newChild = new Child(filteredData);
        await newChild.save();
        return res.status(201).json(newChild);
      } else {
        // Fallback to JSON
        let children = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
        const newChild = req.body;
        if (!newChild.phone) newChild.phone = "";
        newChild.id = children.length
          ? children[children.length - 1].id + 1
          : 1;
        children.push(newChild);
        fs.writeFileSync(DATA_PATH, JSON.stringify(children, null, 2));
        return res.status(201).json(newChild);
      }
    } catch (error) {
      console.error("Error creating child:", error);
      res.status(500).json({ error: "Failed to create child record" });
    }
  });

  // API to update a child's details (supports both MongoDB and JSON fallback)
  app.put("/api/children/:id", async (req, res) => {
    try {
      if (useDatabase()) {
        // Use MongoDB - search by custom id field, not _id
        const updateData = { ...req.body };
        // Normalize gender to proper case
        if (updateData.gender) {
          const genderLower = updateData.gender.toLowerCase();
          if (genderLower === "male") updateData.gender = "Male";
          else if (genderLower === "female") updateData.gender = "Female";
          else if (genderLower === "other") updateData.gender = "Other";
        }
        const child = await Child.findOneAndUpdate(
          { id: parseInt(req.params.id) },
          { $set: updateData },
          { new: true, runValidators: true },
        );
        if (!child) {
          return res.status(404).json({ error: "Child not found" });
        }
        return res.json(child);
      } else {
        // Fallback to JSON
        let children = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
        const childId = parseInt(req.params.id, 10);
        const childIndex = children.findIndex((c) => c.id === childId);

        if (childIndex === -1) {
          return res.status(404).json({ error: "Child not found" });
        }

        const updatedChild = {
          ...children[childIndex],
          ...req.body,
          id: childId,
        };

        children[childIndex] = updatedChild;
        fs.writeFileSync(DATA_PATH, JSON.stringify(children, null, 2));
        return res.json(updatedChild);
      }
    } catch (error) {
      console.error("Error updating child:", error);
      res.status(500).json({ error: "Failed to update child record" });
    }
  });

  // Add a new report for a child (supports both MongoDB and JSON fallback)
  app.post("/api/children/:id/report", async (req, res) => {
    try {
      if (useDatabase()) {
        // Use MongoDB - search by custom id field, not _id
        const child = await Child.findOne({ id: parseInt(req.params.id) });
        if (!child) {
          return res.status(404).json({ error: "Child not found" });
        }

        const incoming = req.body || {};
        const sodaResults = Array.isArray(incoming.sodaResults)
          ? incoming.sodaResults
          : [];
        const summary = incoming.summary || summarizeSODA(sodaResults);

        const newReport = {
          date: incoming.date || new Date(),
          ...incoming,
          sodaResults,
          summary,
        };

        child.reports.push(newReport);
        await child.save();
        return res.status(201).json(newReport);
      } else {
        // Fallback to JSON
        let children = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
        const childId = parseInt(req.params.id, 10);
        const child = children.find((c) => c.id === childId);

        if (!child) {
          return res.status(404).json({ error: "Child not found" });
        }

        const incoming = req.body || {};
        const sodaResults = Array.isArray(incoming.sodaResults)
          ? incoming.sodaResults
          : [];
        const summary = incoming.summary || summarizeSODA(sodaResults);

        const report = {
          ...incoming,
          date: incoming.date || new Date().toISOString(),
          sodaResults,
          summary,
        };

        if (!Array.isArray(child.reports)) child.reports = [];
        child.reports.push(report);

        fs.writeFileSync(DATA_PATH, JSON.stringify(children, null, 2));
        return res.status(201).json(report);
      }
    } catch (error) {
      console.error("Error adding report:", error);
      res.status(500).json({ error: "Failed to add report" });
    }
  });

  // Get all reports for a child (supports both MongoDB and JSON fallback)
  app.get("/api/children/:id/reports", async (req, res) => {
    try {
      if (useDatabase()) {
        // Use MongoDB - search by custom id field, not _id
        const child = await Child.findOne({
          id: parseInt(req.params.id),
        }).select("reports");
        if (!child) {
          return res.status(404).json({ error: "Child not found" });
        }
        return res.json(child.reports || []);
      } else {
        // Fallback to JSON
        let children = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
        const childId = parseInt(req.params.id, 10);
        const child = children.find((c) => c.id === childId);
        if (!child) {
          return res.status(404).json({ error: "Child not found" });
        }
        return res.json(child.reports || []);
      }
    } catch (error) {
      console.error("Error fetching reports:", error);
      res.status(500).json({ error: "Failed to fetch reports" });
    }
  });

  app.get("/download-reference-pdf", (req, res) => {
    const imgPath = path.join(
      __dirname,
      "..",
      "Frontend_main",
      "assets",
      "reference.jpg",
    );
    if (!fs.existsSync(imgPath)) {
      return res.status(404).send("Image not found");
    }

    const doc = new PDFDocument({ autoFirstPage: true, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=Normative_Reference.pdf",
    );

    doc.pipe(res);
    doc.image(imgPath, {
      fit: [500, 750],
      align: "center",
      valign: "center",
    });
    doc.end();
  });

  // Child login endpoint (by numeric id)
  app.post("/api/children/login", async (req, res) => {
    try {
      if (!useDatabase()) {
        // Fallback to JSON
        let children = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
        const { id, phone } = req.body;
        const child = children.find((c) => c.id === Number(id));
        if (child) {
          // Optionally check phone
          if (phone && child.phone && child.phone !== phone) {
            return res
              .status(401)
              .json({ error: "Phone number does not match" });
          }
          return res.json(child);
        } else {
          return res.status(404).json({ error: "Child not found" });
        }
      } else {
        // Use MongoDB
        const { id, phone } = req.body;
        if (!id) return res.status(400).json({ error: "Child ID required" });
        const child = await Child.findOne({ id: Number(id) });
        if (!child) return res.status(404).json({ error: "Child not found" });
        // Optionally check phone
        if (phone && child.phone && child.phone !== phone) {
          return res.status(401).json({ error: "Phone number does not match" });
        }
        return res.json(child);
      }
    } catch (error) {
      console.error("Error in child login:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // Admin login endpoint with JWT token
  app.post("/api/admin/login", (req, res) => {
    const { username, password } = req.body;

    if (
      username === ADMIN_CREDENTIALS.username &&
      password === ADMIN_CREDENTIALS.password
    ) {
      const token = generateToken(username);
      res.json({
        success: true,
        message: "Login successful",
        token,
      });
    } else {
      res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }
  });

  // Protected admin route example
  app.get("/api/admin/stats", verifyToken, async (req, res) => {
    try {
      if (useDatabase()) {
        const totalChildren = await Child.countDocuments();
        const childrenByAge = await Child.aggregate([
          { $group: { _id: "$age", count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ]);
        return res.json({ totalChildren, childrenByAge });
      } else {
        const children = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
        return res.json({ totalChildren: children.length });
      }
    } catch (error) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ error: "Failed to fetch statistics" });
    }
  });

  // Generate comprehensive report PDF (kept from original for compatibility)
  app.post("/api/generate-report", (req, res) => {
    try {
      const payload = req.body || {};
      const child = payload.childDetails || {};
      const report = payload.report || {};
      const sodaResults = Array.isArray(report.sodaResults)
        ? report.sodaResults
        : [];
      const summary = {
        Correct: report.summary?.Correct ?? 0,
        Substitution: report.summary?.Substitution ?? 0,
        Omission: report.summary?.Omission ?? 0,
        Addition: report.summary?.Addition ?? 0,
        Distortion: report.summary?.Distortion ?? 0,
      };
      const suggestions = Array.isArray(payload.suggestions)
        ? payload.suggestions
        : [];

      const doc = new PDFDocument({ size: "A4", margin: 50 });
      res.setHeader("Content-Type", "application/pdf; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Report_${child.name || "Child"}_${Date.now()}.pdf"`,
      );
      // Ensure proper UTF-8 encoding
      res.setHeader("Content-Encoding", "utf-8");
      doc.pipe(res);

      // Register Kannada font if available
      console.log("📝 PDF Generation - Font paths:");
      console.log("  FONT_KANNADA:", FONT_KANNADA);
      console.log("  FONT_LATIN:", FONT_LATIN);
      console.log("  Kannada exists:", fs.existsSync(FONT_KANNADA));
      console.log("  Latin exists:", fs.existsSync(FONT_LATIN));

      const useKannadaFont = fs.existsSync(FONT_KANNADA);
      if (useKannadaFont) {
        console.log("✅ Registering Kannada font:", FONT_KANNADA);
        doc.registerFont("Kannada", FONT_KANNADA);
        doc.registerFont("KannadaBold", FONT_KANNADA); // Use same font for bold
      } else {
        console.warn("⚠️ Kannada font not found, using Helvetica fallback");
      }

      if (fs.existsSync(FONT_LATIN)) {
        console.log("✅ Registering Latin font:", FONT_LATIN);
        doc.registerFont("Latin", FONT_LATIN);
        doc.registerFont("ipa", FONT_LATIN);
      } else {
        console.warn("⚠️ Latin font not found, using Helvetica fallback");
      }

      // Kannada translations
      // const labels = {
      //   title: "ಕನ್ನಡ ಮಾತು ಮೌಲ್ಯಮಾಪನ ವರದಿ",
      //   childDetails: "ಮಗುವಿನ ವಿವರಗಳು:",
      //   name: "ಹೆಸರು:",
      //   age: "ವಯಸ್ಸು:",
      //   gender: "ಲಿಂಗ:",
      //   parent: "ಪೋಷಕರು:",
      //   city: "ನಗರ:",
      //   summaryTitle: "SODA ವಿಶ್ಲೇಷಣೆ ಸಾರಾಂಶ:",
      //   correct: "ಸರಿ:",
      //   substitution: "ಬದಲಿ:",
      //   omission: "ಕಳೆದುಹೋಗಿದೆ:",
      //   addition: "ಸೇರಿಸಿದೆ:",
      //   distortion: "ವಿರೂಪ:",
      //   detailedAnalysis: "ವಿವರವಾದ ವಿಶ್ಲೇಷಣೆ:",
      //   word: "ಪದ:",
      //   error: "ದೋಷ:",
      //   recommendations: "ಶಿಫಾರಸುಗಳು:",
      //   na: "ಲಭ್ಯವಿಲ್ಲ",
      //   // Gender translations
      //   male: "ಪುರುಷ",
      //   female: "ಹೆಣ್ಣು",
      //   other: "ಇತರ",
      //   // Error type translations
      //   correctType: "ಸರಿ",
      //   substitutionType: "ಬದಲಿ",
      //   omissionType: "ಕಳೆದುಹೋಗಿದೆ",
      //   additionType: "ಸೇರಿಸಿದೆ",
      //   distortionType: "ವಿರೂಪ",
      // };

      // Helper functions commented out since labels object is not used
      // const translateGender = (gender) => {
      //   if (!gender) return labels.na;
      //   const g = gender.toLowerCase();
      //   if (g === "male") return labels.male;
      //   if (g === "female") return labels.female;
      //   if (g === "other") return labels.other;
      //   return gender;
      // };

      // const translateErrorType = (errorType) => {
      //   if (!errorType) return labels.na;
      //   const e = errorType.toLowerCase();
      //   if (e === "correct") return labels.correctType;
      //   if (e === "substitution") return labels.substitutionType;
      //   if (e === "omission") return labels.omissionType;
      //   if (e === "addition") return labels.additionType;
      //   if (e === "distortion") return labels.distortionType;
      //   return errorType;
      // };

      // Set default font to Kannada if available, otherwise Helvetica
      const defaultFont = useKannadaFont ? "Kannada" : "Helvetica";
      const boldFont = useKannadaFont ? "KannadaBold" : "Helvetica-Bold";

      doc
        .fontSize(20)
        .font(fs.existsSync(FONT_KANNADA) ? "KannadaBold" : "Helvetica-Bold")
        .text("ಮಗುವಿನ ಪ್ರಗತಿ ವರದಿ", { align: "center" })
        .moveDown(0.5);

      // Child details
      doc
        .fontSize(14)
        .font(fs.existsSync(FONT_KANNADA) ? "KannadaBold" : "Helvetica-Bold")
        .text("ಮಗುವಿನ ವಿವರಗಳು", { underline: true })
        .moveDown(0.3);
      doc
        .fontSize(11)
        .font(fs.existsSync(FONT_KANNADA) ? "Kannada" : "Helvetica")
        .text(`ಹೆಸರು: ${child["ಹೆಸರು"] || child.name || ""}`)
        .text(`ವಯಸ್ಸು: ${child["ವಯಸ್ಸು"] || child.age || ""}`)
        .text(`ಲಿಂಗ: ${child["ಲಿಂಗ"] || child.gender || ""}`)
        .text(`ಪೋಷಕರು: ${child["ಪೋಷಕರು"] || child.parent || ""}`)
        .text(`ನಗರ: ${child["ನಗರ"] || child.city || ""}`)
        .text(`ಇಮೇಲ್: ${child["ಇಮೇಲ್"] || child.email || ""}`)
        .text(`ವಿಳಾಸ: ${child["ವಿಳಾಸ"] || child.address || ""}`)
        .moveDown(0.4);

      // Test meta
      doc
        .fontSize(14)
        .font(fs.existsSync(FONT_KANNADA) ? "KannadaBold" : "Helvetica-Bold")
        .text("ಪರೀಕ್ಷೆ ವಿವರ", { underline: true })
        .moveDown(0.3);
      doc
        .fontSize(11)
        .font(fs.existsSync(FONT_KANNADA) ? "Kannada" : "Helvetica")
        .text(
          `ಪರೀಕ್ಷೆಯ ದಿನಾಂಕ: ${report.date ? new Date(report.date).toLocaleString() : ""}`,
        )
        .text(`ಒಟ್ಟು ಸರಿಯಾದವು: ${summary.Correct ?? 0}`)
        .text(
          `ಒಟ್ಟು ತಪ್ಪುಗಳು: ${(summary.Substitution ?? 0) + (summary.Omission ?? 0) + (summary.Addition ?? 0) + (summary.Distortion ?? 0)}`,
        )
        .moveDown(0.6);

      // SODA table grouped by error type (simple text layout to avoid PDF NaN issues)
      doc
        .fontSize(14)
        .font(fs.existsSync(FONT_KANNADA) ? "KannadaBold" : "Helvetica-Bold")
        .text("SODA ವಿಶ್ಲೇಷಣೆ", { underline: true })
        .moveDown(0.3);
      const order = [
        "Correct",
        "Substitution",
        "Omission",
        "Addition",
        "Distortion",
      ];
      const labels = {
        Correct: "ಸರಿಯಾಗಿವೆ",
        Substitution: "ಬದಲಾವಣೆ",
        Omission: "ಹೊರಗುಳಿಕೆ",
        Addition: "ಸೇರಿಕೆ",
        Distortion: "ವಿಕೃತಿ",
      };

      const hasKannadaFont = fs.existsSync(FONT_KANNADA);
      const latinFont = fs.existsSync(FONT_LATIN) ? "ipa" : "Helvetica";

      order.forEach((type) => {
        const rows = sodaResults.filter(
          (r) => (r.error_type || "Correct") === type,
        );
        if (!rows.length) return;

        doc.moveDown(0.2);
        doc
          .fontSize(12)
          .font(hasKannadaFont ? "KannadaBold" : "Helvetica-Bold")
          .text(labels[type] || type);

        doc.fontSize(10).font(latinFont);
        doc.text("Error Type | Target Word | Spoken Phonemes");
        doc.text(
          "------------------------------------------------------------",
        );

        rows.forEach((r) => {
          const spoken = r.spoken_ipa || r.spoken || r.spoken_phonemes || "";
          const target = r.target_word || "";

          // Error type (Latin)
          doc.font(latinFont).text(`${type} | `, { continued: true });

          // Target word (Kannada if font available)
          if (hasKannadaFont) {
            doc.font("Kannada").text(target, { continued: true });
          } else {
            doc.font(latinFont).text(target, { continued: true });
          }

          // Spoken phonemes (Latin / IPA)
          doc.font(latinFont).text(` | ${spoken}`);
        });
        doc.moveDown(0.6);
      });

      /* ================= NEW ADDITION : FINAL SUMMARY ================= */

      doc.moveDown(1);

      /* ---- Correct List ---- */
      doc
        .fontSize(14)
        .font(hasKannadaFont ? "KannadaBold" : "Helvetica-Bold")
        .text("ಸರಿಯಾಗಿ ಉಚ್ಚರಿಸಿದ ಪದಗಳು", { underline: true })
        .moveDown(0.3);

      doc
        .fontSize(11)
        .font(hasKannadaFont ? "Kannada" : "Helvetica")
        .text(
          Array.isArray(payload.correctList) && payload.correctList.length
            ? payload.correctList.join(", ")
            : "ಯಾವುದೂ ಇಲ್ಲ",
        );

      doc.moveDown(0.6);

      /* ---- Wrong List ---- */
      doc
        .fontSize(14)
        .font(hasKannadaFont ? "KannadaBold" : "Helvetica-Bold")
        .text("ತಪ್ಪಾಗಿ ಉಚ್ಚರಿಸಿದ ಪದಗಳು", { underline: true })
        .moveDown(0.3);

      doc
        .fontSize(11)
        .font(hasKannadaFont ? "Kannada" : "Helvetica")
        .text(
          Array.isArray(payload.wrongList) && payload.wrongList.length
            ? payload.wrongList.join(", ")
            : "ಯಾವುದೂ ಇಲ್ಲ",
        );

      doc.moveDown(0.6);

      /* ---- Practice List ---- */
      doc
        .fontSize(14)
        .font(hasKannadaFont ? "KannadaBold" : "Helvetica-Bold")
        .text("ಅಭ್ಯಾಸಕ್ಕೆ ಅಗತ್ಯವಿರುವ ಧ್ವನಿಗಳು", { underline: true })
        .moveDown(0.3);

      doc
        .fontSize(11)
        .font(hasKannadaFont ? "Kannada" : latinFont)
        .text(
          Array.isArray(payload.practiceList) && payload.practiceList.length
            ? payload.practiceList.join(", ")
            : "ವಿಶೇಷ ಅಭ್ಯಾಸ ಅಗತ್ಯವಿಲ್ಲ",
        );

      doc.moveDown(0.6);

      /* ---- Final Suggestion ---- */
      doc
        .fontSize(14)
        .font(hasKannadaFont ? "KannadaBold" : "Helvetica-Bold")
        .text("ಒಟ್ಟು ಸಲಹೆ", { underline: true })
        .moveDown(0.3);

      doc
        .fontSize(11)
        .font(hasKannadaFont ? "Kannada" : "Helvetica")
        .text(
          payload.suggestion
            ? payload.suggestion
            : "ಮಗು ವಯಸ್ಸಿಗೆ ಅನುಗುಣವಾಗಿ ಧ್ವನಿಗಳನ್ನು ಸರಿಯಾಗಿ ಉಚ್ಚರಿಸುತ್ತಿದೆ. ನಿರಂತರ ಅಭ್ಯಾಸ ಮುಂದುವರಿಸಿರಿ.",
        );

      doc
        .moveDown(1)
        .fontSize(9)
        .font(fs.existsSync(FONT_KANNADA) ? "Kannada" : "Helvetica")
        .text(`ವರದಿ ಉತ್ಪಾದಿಸಿದ ದಿನಾಂಕ: ${new Date().toLocaleString()}`, {
          align: "center",
        });

      doc.end();

      // // Title
      // doc.fontSize(20).font(boldFont).text(labels.title, { align: "center" });
      // doc.moveDown();

      // // Child details
      // doc.fontSize(14).font(boldFont).text(labels.childDetails);
      // doc.fontSize(12).font(defaultFont);
      // doc.text(`${labels.name} ${child.name || labels.na}`);
      // doc.text(`${labels.age} ${child.age || labels.na}`);
      // doc.text(`${labels.gender} ${translateGender(child.gender)}`);
      // doc.text(`${labels.parent} ${child.parent || labels.na}`);
      // doc.text(`${labels.city} ${child.city || labels.na}`);
      // doc.moveDown();

      // // Summary
      // doc.fontSize(14).font(boldFont).text(labels.summaryTitle);
      // doc.fontSize(12).font(defaultFont);
      // doc.text(`${labels.correct} ${summary.Correct}`);
      // doc.text(`${labels.substitution} ${summary.Substitution}`);
      // doc.text(`${labels.omission} ${summary.Omission}`);
      // doc.text(`${labels.addition} ${summary.Addition}`);
      // doc.text(`${labels.distortion} ${summary.Distortion}`);
      // doc.moveDown();

      // // Detailed results
      // if (sodaResults.length > 0) {
      //   doc.fontSize(14).font(boldFont).text(labels.detailedAnalysis);
      //   doc.fontSize(10).font(defaultFont);
      //   sodaResults.forEach((item, index) => {
      //     const errorType = translateErrorType(item.error_type);
      //     const wordText = item.word || labels.na;
      //     doc.text(
      //       `${index + 1}. ${labels.word} ${wordText}, ${labels.error} ${errorType}`,
      //     );
      //   });
      //   doc.moveDown();
      // }

      // // Suggestions
      // if (suggestions.length > 0) {
      //   doc.fontSize(14).font(boldFont).text(labels.recommendations);
      //   doc.fontSize(12).font(defaultFont);
      //   suggestions.forEach((sugg, idx) => {
      //     doc.text(`${idx + 1}. ${sugg}`);
      //   });
      // }

      // doc.end();
    } catch (error) {
      console.error("Error generating PDF:", error);
      res.status(500).json({ error: "Failed to generate report" });
    }
  });

  // Health check endpoint
  app.get("/health", async (req, res) => {
    const health = {
      nodejs: "OK",
      timestamp: new Date().toISOString(),
      pythonBackend: {
        url: PYTHON_BACKEND_URL,
        status: "unknown",
      },
    };

    try {
      // Try to reach Python backend
      const pythonResponse = await axios.get(`${PYTHON_BACKEND_URL}/`, {
        timeout: 3000,
      });
      health.pythonBackend.status = "OK";
    } catch (error) {
      health.pythonBackend.status = "ERROR";
      health.pythonBackend.error = error.message;
      health.pythonBackend.code = error.code;
    }

    const statusCode = health.pythonBackend.status === "OK" ? 200 : 503;
    res.status(statusCode).json(health);
  });

  // Proxy endpoint for Python SODA analysis
  app.post("/analyze_soda", upload.single("audio"), async (req, res) => {
    try {
      // Log incoming request details
      console.log("📥 Received SODA request:");
      console.log("  - target_word:", req.body.target_word);
      console.log("  - file present:", !!req.file);
      console.log("  - file size:", req.file?.size || 0);

      // Validate inputs
      if (!req.body.target_word) {
        return res.status(400).json({
          error: "Missing target_word parameter",
        });
      }

      if (!req.file) {
        return res.status(400).json({
          error: "Missing audio file",
        });
      }

      const formData = new FormData();
      formData.append("target_word", req.body.target_word);
      formData.append("audio", req.file.buffer, {
        filename: req.file.originalname || "recording.wav",
        contentType: req.file.mimetype,
      });

      console.log(
        `🔗 Proxying SODA request to ${PYTHON_BACKEND_URL}/analyze_soda`,
      );

      const response = await axios.post(
        `${PYTHON_BACKEND_URL}/analyze_soda`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 60000, // 60 second timeout
        },
      );

      console.log("✅ SODA analysis successful");
      res.json(response.data);
    } catch (error) {
      console.error("❌ SODA proxy error:", error);
      console.error("Error details:", {
        message: error.message,
        code: error.code,
        response: error.response?.data,
        status: error.response?.status,
      });

      if (error.response) {
        // Python backend returned an error
        console.error("Python backend error:", error.response.data);
        res.status(error.response.status).json(error.response.data);
      } else if (error.code === "ECONNREFUSED") {
        // Python backend not accessible
        res.status(503).json({
          error: "Python backend unavailable",
          details: `Cannot connect to ${PYTHON_BACKEND_URL}. Make sure Flask server is running.`,
        });
      } else if (error.code === "ETIMEDOUT") {
        res.status(504).json({
          error: "Request timeout",
          details: "Python backend took too long to respond",
        });
      } else {
        res.status(500).json({
          error: "Failed to analyze audio",
          details: error.message || "Unknown error occurred",
          code: error.code,
        });
      }
    }
  });

  // Proxy endpoint for IPA to Kannada conversion
  app.post("/ipa2kannada", async (req, res) => {
    try {
      console.log("📥 Received IPA2Kannada request:", req.body);

      // Validate input
      if (!req.body.syllables || !Array.isArray(req.body.syllables)) {
        return res.status(400).json({
          error: "Missing or invalid syllables parameter",
        });
      }

      console.log(
        `🔗 Proxying IPA2Kannada request to ${PYTHON_BACKEND_URL}/ipa2kannada`,
      );

      const response = await axios.post(
        `${PYTHON_BACKEND_URL}/ipa2kannada`,
        req.body,
        {
          headers: {
            "Content-Type": "application/json",
          },
          timeout: 10000, // 10 second timeout
        },
      );

      console.log("✅ IPA2Kannada conversion successful");
      res.json(response.data);
    } catch (error) {
      console.error("❌ IPA2Kannada proxy error:", error.message);

      if (error.response) {
        // Python backend returned an error
        console.error("Python backend error:", error.response.data);
        res.status(error.response.status).json(error.response.data);
      } else if (error.code === "ECONNREFUSED") {
        // Python backend not accessible
        res.status(503).json({
          error: "Python backend unavailable",
          details: `Cannot connect to ${PYTHON_BACKEND_URL}. Make sure Flask server is running.`,
        });
      } else if (error.code === "ETIMEDOUT") {
        res.status(504).json({
          error: "Request timeout",
          details: "Python backend took too long to respond",
        });
      } else {
        res.status(500).json({
          error: "Failed to convert IPA to Kannada",
          details: error.message || "Unknown error occurred",
          code: error.code,
        });
      }
    }
  });

  // Fallback: serve index.html for any unknown route (SPA fallback - MUST be last)
  // Express 5 requires named wildcard parameter syntax instead of just "*"
  app.get("/{*splat}", (req, res) => {
    const indexPath =
      process.env.NODE_ENV === "production" &&
      !fs.existsSync(path.join(__dirname, "..", "Frontend_main", "index.html"))
        ? path.join(__dirname, "index.html") // Docker: index.html is in /app
        : path.join(__dirname, "..", "Frontend_main", "index.html"); // Local: ../Frontend_main/index.html
    res.sendFile(indexPath);
  });

  // Start server (wrapped in async function at top)
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 TTS endpoint: http://localhost:${PORT}/tts?text=ಅಮ್ಮ`);
    console.log(`🔗 Python backend: ${PYTHON_BACKEND_URL}`);
    console.log(`💾 Database: ${useDatabase() ? "MongoDB" : "JSON fallback"}`);
    console.log(
      `☁️  Storage: ${cloudStorage.useCloud ? "Azure Blob" : "Local"}`,
    );
    console.log(`🔐 Admin user: ${ADMIN_CREDENTIALS.username}`);
  });
})(); // End of async function
