// Invio email via SMTP (Aruba). Inerte se SMTP_HOST, SMTP_USER o SMTP_PASS
// mancano: chi lo usa controlla isMailConfigured() prima di contarci.
const nodemailer = require("nodemailer");
const {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  MAIL_FROM,
} = require("../config/config");

let transporter = null;

const isMailConfigured = () => Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, html, text }) {
  if (!isMailConfigured()) {
    throw new Error("SMTP non configurato (SMTP_HOST, SMTP_USER, SMTP_PASS)");
  }
  return getTransporter().sendMail({
    from: MAIL_FROM || SMTP_USER,
    to: Array.isArray(to) ? to.join(", ") : to,
    subject,
    html,
    text,
  });
}

module.exports = { isMailConfigured, sendMail };
