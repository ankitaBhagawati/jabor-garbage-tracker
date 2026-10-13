// The text of the Privacy Policy and the Terms and Conditions, as data, so a test can check it. It describes what
// Jabor actually does (see docs/PUBLIC-FORM.md and docs/ACCESS-MATRIX.md). When the app starts using another service
// or collecting something new, change this text in the same pull request. src/legal/legal.check.js lists the services.

export const CONTACT_EMAIL = "jaborassam@gmail.com";
export const UPDATED = "13 October 2026";

export type Section = { title: string; paragraphs?: string[]; list?: string[]; after?: string[] };
export type Doc = { path: string; title: string; intro: string[]; sections: Section[] };

export const PRIVACY: Doc = {
  path: "/privacy",
  title: "Privacy Policy",
  intro: [
    "Jabor is a public garbage tracker for Assam. This page says what information Jabor collects, why, who can see it, and what you can ask us to do.",
    "If anything here is unclear, write to us at " + CONTACT_EMAIL + ".",
  ],
  sections: [
    {
      title: "What you give us when you report garbage",
      paragraphs: ["When you send a report you give us:"],
      list: [
        "a photo of the garbage,",
        "a short description and the type of waste,",
        "the district and constituency, and the area and landmark you type in,",
        "in a municipality that has switched it on, your answer to whether the place is inside the municipal area, and a ward if you choose one,",
        "your name and email address, only if you choose to give them. They are optional. They are not collected in anonymous mode.",
      ],
      after: ["Jabor does not ask for your GPS location and does not ask your browser for location permission. Please do not put personal details about other people in the description."],
    },
    {
      title: "What is public",
      paragraphs: [
        "A report is public as soon as it is sent. Anyone can see its photo, description, waste type, area, landmark, district, constituency, status, the cleanup photo if one is approved, and the names of the MLA and MP for that constituency. Search engines and other people may copy what is public.",
        "Your name and email are never shown on the public site. Photos can show people, vehicles or house numbers by accident. Take the photo so that it shows the garbage and not people.",
      ],
    },
    {
      title: "What stays private",
      paragraphs: [
        "Your name and email, if you gave them, are stored apart from the report. Only Jabor's owner can see them. Municipal staff who use Jabor to follow up reports for their municipality see the report, its ward and its status, not your name or email.",
        "If you give an email address, we send you one confirmation email through our email service. We do not send marketing email.",
      ],
    },
    {
      title: "Who we may send a report to",
      paragraphs: [
        "To get an issue noticed, Jabor may email a report to the authority responsible, or post it on Jabor's public X account. This includes the photo, the description and the place. We do not pass your name or email to authorities or post them.",
      ],
    },
    {
      title: "Technical information",
      paragraphs: [
        "When you send a report or sign in, your IP address is used for spam protection. A short-lived counter keyed to your IP address limits how often one address can send reports, and Cloudflare Turnstile checks that you are a person and not a bot. The IP address can also appear in our server logs.",
      ],
    },
    {
      title: "Analytics, cookies and storage",
      paragraphs: [
        "We use Google Analytics to count visits and page views, and how many reports are sent, so we can see whether Jabor is working. Google Analytics uses cookies and sees your IP address, browser and device, and an approximate location. We do not use it for advertising.",
        "Staff sign-in uses cookies that are needed to keep a staff member signed in. Visitors who only read and report do not get these cookies.",
        "Jabor saves a copy of its pages in your browser so it opens faster and shows a simple page when you are offline.",
      ],
    },
    {
      title: "Error reports",
      paragraphs: [
        "If Jabor crashes we may receive an error report through Sentry. We remove email addresses and sign-in tokens from these reports before they are sent.",
      ],
    },
    {
      title: "Support payments",
      paragraphs: [
        "You can support Jabor with a voluntary payment. The payment is handled by Razorpay. Jabor does not see or store your card, UPI or bank details. Razorpay's own privacy policy applies to the payment.",
      ],
    },
    {
      title: "Services that handle data for us",
      paragraphs: ["Jabor uses these services to run. Each one handles only what it needs for its job."],
      list: [
        "Supabase: the database where reports are stored.",
        "Vercel: hosting for the website.",
        "Cloudinary: storage for report photos.",
        "Cloudflare Turnstile: bot checks on forms.",
        "Upstash: short-lived counters for spam limits.",
        "Resend: sending confirmation emails.",
        "Google Analytics: visit counts.",
        "Sentry: error reports.",
        "Razorpay: voluntary support payments.",
      ],
    },
    {
      title: "How long we keep information",
      paragraphs: [
        "Reports stay on Jabor so that the record of a problem and of its cleanup stays available. A report that is hidden is kept but not shown. Your name and email are kept with the report they came with, until you ask us to remove them. Spam counters expire within an hour. Logs and analytics are kept by the services above under their own settings.",
      ],
    },
    {
      title: "Your choices",
      list: [
        "Report in anonymous mode, and no name or email is collected.",
        "Write to " + CONTACT_EMAIL + " to ask us to remove your name and email, to hide a report you sent, or to correct a mistake. We reply by email.",
        "Block or delete cookies in your browser. Jabor still works for reading and reporting.",
      ],
    },
    {
      title: "Security",
      paragraphs: [
        "Jabor uses encrypted connections, and staff only see what their role allows. No system is perfectly secure, so please share only what you are comfortable having in a public report.",
      ],
    },
    {
      title: "Changes to this policy",
      paragraphs: ["If we change this policy we will change the date at the top of this page. If a change matters for what you have already shared, we will say so on the site."],
    },
    {
      title: "Contact",
      paragraphs: ["Questions, requests or complaints about your information: " + CONTACT_EMAIL + "."],
    },
  ],
};

export const TERMS: Doc = {
  path: "/terms",
  title: "Terms and Conditions",
  intro: [
    "These terms apply when you use Jabor, the public garbage tracker for Assam. By using the site or sending a report you agree to them. If you do not agree, please do not use Jabor.",
  ],
  sections: [
    {
      title: "What Jabor is",
      paragraphs: [
        "Jabor lets people report garbage, see reports on a public list, and follow whether they were cleaned. Jabor is an independent civic tool. It is not a government body and it does not clean garbage itself. Where a municipality uses Jabor, its staff can see and update the reports for their area.",
      ],
    },
    {
      title: "What you may report",
      list: [
        "Report real garbage at a real place, with a photo you took yourself.",
        "Give an accurate place and description.",
        "Do not include other people's personal details, and avoid photographing faces, number plates and house numbers.",
        "Do not send spam, duplicates, jokes, abuse, false claims, or anything unlawful or hateful.",
        "Do not use Jabor to harass a person or business, or to promote anything.",
      ],
    },
    {
      title: "Your content",
      paragraphs: [
        "You keep ownership of your photos and text. By sending a report you give Jabor a free, non-exclusive right to store it, show it publicly on Jabor, send it to the authority responsible, post it on Jabor's public X account, and use it for counts and statistics. Reports are public immediately, and other people may copy what is public.",
        "You confirm that you took the photo or have the right to send it, and that it does not break anyone else's rights.",
      ],
    },
    {
      title: "Moderation",
      paragraphs: [
        "We may hide, correct or remove a report, for example if it is spam, a duplicate, outside the area, unclear, or breaks these terms. A hidden report is kept but not shown. We may refuse a report or stop access for someone who misuses Jabor.",
      ],
    },
    {
      title: "Status and cleanup",
      paragraphs: [
        "The status of a report (active, in progress, cleaned) comes from municipal staff, from cleanup proof that citizens send and Jabor's team checks, or from Jabor's own review. Jabor does not promise that any report will be acted on, or by when. A report that is marked cleaned may be wrong, and you can write to us if it is.",
      ],
    },
    {
      title: "Anonymous reports",
      paragraphs: ["In anonymous mode we do not collect your name or email. We cannot contact you about the report, and we cannot find it again by your name if you ask us to change it later."],
    },
    {
      title: "Support payments",
      paragraphs: [
        "Supporting Jabor is voluntary. A payment is handled by Razorpay, does not buy any service, and gives you no right over Jabor or its reports. If a payment goes wrong, write to us.",
      ],
    },
    {
      title: "Using the site",
      paragraphs: [
        "Do not try to break into Jabor, overload it, bypass its spam checks, or collect its data in a way that harms the service. Public reports may be viewed and shared normally.",
      ],
    },
    {
      title: "No guarantee",
      paragraphs: [
        "Jabor is provided as it is. It may be unavailable, slow or wrong at times. We do not guarantee that it is complete, that its reports are accurate, or that it will always be online.",
      ],
    },
    {
      title: "Limits on our responsibility",
      paragraphs: [
        "To the extent the law allows, Jabor and the people who run it are not responsible for any loss that comes from using or relying on Jabor, from what other users post, or from what an authority does or does not do about a report. Nothing here limits any right you have under law that cannot be limited.",
      ],
    },
    {
      title: "Changes to these terms",
      paragraphs: ["We may change these terms. We will change the date at the top of this page. If you keep using Jabor after a change, you accept the new terms."],
    },
    {
      title: "Governing law",
      paragraphs: ["These terms are governed by the laws of India."],
    },
    {
      title: "Contact",
      paragraphs: ["Questions about these terms: " + CONTACT_EMAIL + ". Our privacy practices are in the Privacy Policy."],
    },
  ],
};

export const DOCS = [PRIVACY, TERMS];
