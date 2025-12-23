console.log("");
const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// Keep-alive route
app.get("/", (req, res) => {
  res.send("Server is alive!");
});

// Start Express server
app.listen(PORT, () => {
  console.log(`Express server running on port ${PORT}`);
});

const { Telegraf, session, Markup } = require("telegraf");
const fs = require("fs-extra");
const path = require("path");
const puppeteer = require("puppeteer");
const fetch = require("node-fetch");

// --- আপনার নতুন তথ্য অনুযায়ী আপডেট করা হয়েছে ---
const BOT_TOKEN = "8412483312:AAH0_liZjwNdcetBjRhRK1Ki4BAX0g9ocfA"; // আপনার বটের টোকেন
const ADMIN_PASSWORD = "ABab@3574";
const DEV_PASSWORD = "payfirst";
const CHANNEL_ID = "@advebd"; // আপনার নতুন চ্যানেল আইডি
const ADMIN_USER_ID = "6732130275"; // আপনার নতুন অ্যাডমিন আইডি
// ---------------------------------------------

// File Paths
const NUMBERS_FILE = path.join(__dirname, "numbers.txt");
const COUNTRIES_FILE = path.join(__dirname, "countries.json");
const USERS_FILE = path.join(__dirname, "users.json");
const OUTPUT_FILE = path.join(__dirname, "sms_cdr_stats.txt");

const bot = new Telegraf(BOT_TOKEN);

// Default countries if countries.json is missing
const default_countries = {
  221: { name: "Senegal", flag: "🇸🇳" },
  225: { name: "Côte d'Ivoire", flag: "🇨🇮" },
  996: { name: "Kyrgyzstan", flag: "🇰🇬" },
  95: { name: "Myanmar", flag: "🇲🇲" },
  251: { name: "Ethiopia", flag: "🇪🇹" },
};

let countries = {};
let numbersByCountry = {};
let users = {};
let assignedNumbers = {}; // Tracks number -> chatId mapping

// --- Initialization and File Loading ---

async function initialize() {
  // Load countries
  try {
    if (await fs.pathExists(COUNTRIES_FILE)) {
      countries = await fs.readJson(COUNTRIES_FILE);
    } else {
      countries = default_countries;
      await fs.writeJson(COUNTRIES_FILE, countries, { spaces: 2 });
      console.log("Created countries.json with default countries");
    }
  } catch (error) {
    console.error("Error loading or creating countries.json:", error);
    countries = default_countries;
  }

  // Load numbers
  try {
    if (await fs.pathExists(NUMBERS_FILE)) {
      const rawContent = await fs.readFile(NUMBERS_FILE, "utf8");
      const lines = rawContent.split(/\r?\n/).filter((line) => line.trim());

      lines.forEach((number) => {
        number = number.trim();
        if (/^\d{10,15}$/.test(number)) {
          const countryCode = getCountryCode(number);
          if (countryCode) {
            if (!numbersByCountry[countryCode]) {
              numbersByCountry[countryCode] = [];
            }
            if (!numbersByCountry[countryCode].includes(number)) {
              numbersByCountry[countryCode].push(number);
            }
          }
        }
      });
    } else {
      console.log("numbers.txt not found. Starting with an empty number list.");
    }
  } catch (error) {
    console.error("Error loading numbers.txt:", error);
  }

  // Load users
  try {
    if (await fs.pathExists(USERS_FILE)) {
      users = await fs.readJson(USERS_FILE);
    } else {
      await fs.writeJson(USERS_FILE, users);
      console.log("Created users.json");
    }
  } catch (error) {
    console.error("Error loading users.json:", error);
  }

  console.log("Initialization complete.");
}

// --- Helper Functions ---

const saveCountries = async () => {
  try {
    await fs.writeJson(COUNTRIES_FILE, countries, { spaces: 2 });
  } catch (error) {
    console.error("Error saving countries.json:", error);
  }
};

const saveNumbers = async () => {
  try {
    const lines = Object.values(numbersByCountry).flat();
    await fs.writeFile(NUMBERS_FILE, lines.join("\n"));
  } catch (error) {
    console.error("Error saving numbers.txt:", error);
  }
};

const saveUsers = async () => {
  try {
    await fs.writeJson(USERS_FILE, users);
  } catch (error) {
    console.error("Error saving users.json:", error);
  }
};

function getCountryCode(number) {
  const threeDigit = number.slice(0, 3);
  if (countries[threeDigit]) return threeDigit;
  const twoDigit = number.slice(0, 2);
  if (countries[twoDigit]) return twoDigit;
  return null;
}

function getNumberForCountry(countryCode) {
  const availableNumbers = (numbersByCountry[countryCode] || []).filter(
    (num) => !assignedNumbers[num]
  );
  if (availableNumbers.length === 0) return null;
  const index = Math.floor(Math.random() * availableNumbers.length);
  return availableNumbers[index];
}

function removeNumberFromCountry(countryCode, number) {
  if (numbersByCountry[countryCode]) {
    numbersByCountry[countryCode] = numbersByCountry[countryCode].filter(
      (n) => n !== number
    );
    if (numbersByCountry[countryCode].length === 0) {
      delete numbersByCountry[countryCode];
    }
  }
}

function assignNumberToUser(chatId, number) {
  // Release any previous number assigned to this user
  for (const [num, id] of Object.entries(assignedNumbers)) {
    if (id === chatId) {
      delete assignedNumbers[num];
    }
  }
  assignedNumbers[number] = chatId;
}

function releaseNumberFromUser(chatId) {
    for (const [num, id] of Object.entries(assignedNumbers)) {
        if (id === chatId) {
            delete assignedNumbers[num];
            console.log(`Released number ${num} from user ${chatId}`);
            return;
        }
    }
}


// --- Session and Bot Middleware ---

bot.use(
  session({
    defaultSession: () => ({
      isVerified: false,
      isAdmin: false,
      isDev: false,
      waitingForForceUpload: false,
      processedOtps: {},
      otpMessageIds: [],
    }),
  })
);

// Middleware to ensure user exists
bot.use(async (ctx, next) => {
    if (ctx.chat && !users[ctx.chat.id]) {
        users[ctx.chat.id] = { joined: new Date().toISOString() };
        await saveUsers();
    }
    return next();
});

// Middleware to stop any active polling before handling a new command/action
bot.use((ctx, next) => {
    if (ctx.session?.otpPollingInterval) {
        clearInterval(ctx.session.otpPollingInterval);
        ctx.session.otpPollingInterval = null;
    }
    return next();
});


// --- OTP Checking Logic ---

async function checkForOtp(ctx, number, silent = false) {
    try {
        if (!(await fs.pathExists(OUTPUT_FILE))) return false;

        const existingData = await fs.readFile(OUTPUT_FILE, "utf8");
        const lines = existingData.split("\n");
        let newOtpsFound = false;

        const regex = /^OTP Code:\s*(\S+)\s+Number:\s*(\S+)\s+Country:\s*([\p{L}\p{M}\p{N}\p{Emoji_Presentation}\s]+?)\s+Service:\s*(\S+)\s+Message:\s*([\s\S]+?)\s+Date:\s*(.+)$/u;

        for (const line of lines) {
            if (line.includes(number)) {
                const match = line.match(regex);
                if (!match) continue;
                
                const [, otp, phoneNumber, country, service, message] = match;
                const otpKey = `${otp}_${phoneNumber}_${service}`;

                if (ctx.session.processedOtps[otpKey]) continue;

                ctx.session.processedOtps[otpKey] = true;
                newOtpsFound = true;
                
                const countryCode = getCountryCode(phoneNumber);
                const countryInfo = countries[countryCode] || { name: country, flag: "🌍" };
                
                const formattedMessage = `📞 Number: \`${phoneNumber}\`\n🌐 Country: ${countryInfo.flag} ${countryInfo.name}\n🔧 Service: ${service}\n\n🔑 OTP Code: \`${otp}\`\n\n📜 Message: *${message}*\n\n\`${otp}\``;
                
                const sentMessage = await ctx.reply(formattedMessage, { parse_mode: "Markdown" });
                ctx.session.otpMessageIds.push(sentMessage.message_id);
            }
        }

        return newOtpsFound;

    } catch (error) {
        console.error("Error reading sms_cdr_stats.txt:", error);
        if (!silent) {
            await ctx.reply('❌ Error fetching OTP. Please try again later.');
        }
        return false;
    }
}

function startOtpPolling(ctx, number) {
    if (ctx.session.otpPollingInterval) {
        clearInterval(ctx.session.otpPollingInterval);
    }

    let pollCount = 0;
    const maxPolls = 50; // 50 seconds (50 * 1-second interval)

    ctx.session.otpPollingInterval = setInterval(async () => {
        if (pollCount++ >= maxPolls) {
            clearInterval(ctx.session.otpPollingInterval);
            ctx.session.otpPollingInterval = null;
            
            const timeoutMessage = `❌ No OTP found for \`${number}\` within the time limit.`;
            await ctx.reply(timeoutMessage, {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔄 Check Again", callback_data: `check_otp_again:${number}` }],
                        [{ text: "🔗 Check in OTP Group", url: `https://t.me/${CHANNEL_ID.substring(1)}` }], // Dynamic OTP group link
                    ],
                },
            });
            return;
        }

        const found = await checkForOtp(ctx, number, true); // Silent check
        if (found) {
            clearInterval(ctx.session.otpPollingInterval);
            ctx.session.otpPollingInterval = null;
        }
    }, 1000);
}


// --- Bot Commands and Actions ---

bot.telegram.setMyCommands([
    { command: "start", description: "Start the bot" },
]);

const mainMenu = Markup.keyboard([
    ["📞 Get Number", "HELP ?"],
    ["🏠 Start Menu", "🔗 Join Channel"],
]).resize();

bot.start(async (ctx) => {
    if (ctx.session.isVerified) {
        return ctx.reply("✅ Verified! Welcome to 👑Fx King Number Bot! ✨", mainMenu);
    }
    
    await ctx.reply("⚠️ First join the channel and verify.", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🔗 Join Channel", url: `https://t.me/${CHANNEL_ID.substring(1)}` }], // Updated channel link
                [{ text: "✅ Verify Channel", callback_data: "verify_channel" }],
            ],
        },
    });
});

bot.action("verify_channel", async (ctx) => {
    try {
        const chatMember = await ctx.telegram.getChatMember(CHANNEL_ID, ctx.from.id);
        if (["member", "administrator", "creator"].includes(chatMember.status)) {
            ctx.session.isVerified = true;
            await ctx.editMessageText("✅ Verification successful! You can now use the bot.", {
                reply_markup: {
                    inline_keyboard: [[{ text: "📞 Get Number", callback_data: "get_number_menu" }]],
                },
            });
            await ctx.reply("📋 Main Menu:", mainMenu);
        } else {
            await ctx.answerCbQuery("⚠️ Please join the channel first!", { show_alert: true });
        }
    } catch (error) {
        console.error("Error in verify_channel action:", error);
        await ctx.answerCbQuery("❌ Error verifying membership. Is the bot an admin in the channel?", { show_alert: true });
    }
});

const getNumberMenu = async (ctx, edit = false) => {
    const keyboard = Object.entries(countries).map(([code, { flag, name }], index) => {
        const availableCount = (numbersByCountry[code] || []).filter(num => !assignedNumbers[num]).length;
        const status = availableCount > 0 ? `🟢 ${availableCount}` : "🔴 Used";
        return [{ text: `${flag} ${index + 1}. ${name} ${status}`, callback_data: `select:${code}` }];
    });
  
    const text = "📞 Get Number\n🌍 Select Your Country:";
    const markup = { reply_markup: { inline_keyboard: keyboard } };

    try {
        if (edit) {
            await ctx.editMessageText(text, markup);
        } else {
            await ctx.reply(text, markup);
        }
    } catch (error) {
        if (!error.description?.includes("message is not modified")) {
            console.error("Error in getNumberMenu:", error);
        }
    }
};

bot.hears("📞 Get Number", async (ctx) => getNumberMenu(ctx));
bot.action("get_number_menu", async (ctx) => getNumberMenu(ctx, true));


bot.hears("🏠 Start Menu", (ctx) => ctx.reply("🏠 Welcome back!", mainMenu));
bot.hears("🔗 Join Channel", (ctx) => ctx.reply(`🔗 Please join our channel: https://t.me/${CHANNEL_ID.substring(1)}`)); // Updated channel link
bot.hears("HELP ?", (ctx) => {
    ctx.reply("🔗 Talk to Admin", {
        reply_markup: {
            inline_keyboard: [[{ text: "🔗 Admin Support", url: `tg://user?id=${ADMIN_USER_ID}` }]], // Updated admin link
        },
    });
});


const displayNewNumber = async (ctx, countryCode) => {
    const number = getNumberForCountry(countryCode);

    if (!number) {
        await ctx.reply(`❌ No more numbers available for ${countries[countryCode].flag} ${countries[countryCode].name}.`, {
            reply_markup: {
                inline_keyboard: [[{ text: "📞 Select Another Country", callback_data: "get_number_menu" }]],
            },
        });
        return;
    }

    assignNumberToUser(ctx.chat.id, number);
    
    // Reset session for the new number
    ctx.session.processedOtps = {};
    ctx.session.otpMessageIds = [];

    const message = `\n**👑Fx King Number Bot**\n\n📱 Your Number:\n1️⃣ \`${number}\`\n\n🔑 OTP Code: Will appear here ✅\n\n⏳ Waiting time: Max 50 seconds\n✨ Please be patient!`;
    
    await ctx.reply(message, {
        parse_mode: "Markdown",
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "Used & Get New", callback_data: `used:${countryCode}:${number}` },
                    { text: "Not Used & Get New", callback_data: `notused:${countryCode}:${number}` },
                ],
                [{ text: "🔗 Check in OTP Group", url: `https://t.me/${CHANNEL_ID.substring(1)}` }], // Updated channel link
            ],
        },
    });

    const found = await checkForOtp(ctx, number, false);
    if (!found) {
        startOtpPolling(ctx, number);
    }
};


// Main callback handler
bot.on("callback_query", async (ctx) => {
    try {
        const data = ctx.callbackQuery.data;
        if (!data || typeof data !== "string") return await ctx.answerCbQuery("Invalid callback data");
        
        // Actions that don't require verification
        if (data === 'verify_channel') return; // Handled by its own action
        
        // All other actions require verification
        if (!ctx.session.isVerified) {
            return await ctx.answerCbQuery("Please join the channel and verify first!", { show_alert: true });
        }
        
        const [action, ...args] = data.split(":");

        switch (action) {
            case "get_number_menu":
                await getNumberMenu(ctx, true);
                break;
            
            case "select": {
                const [countryCode] = args;
                await ctx.deleteMessage().catch(() => {}); // Delete the country list
                await displayNewNumber(ctx, countryCode);
                break;
            }

            case "used":
            case "notused": {
                const [countryCode, oldNumber] = args;
                await ctx.deleteMessage().catch(() => {}); // Delete the old number message

                // Clean up previous OTP messages
                for (const msgId of ctx.session.otpMessageIds) {
                    await ctx.deleteMessage(msgId).catch(() => {});
                }
                
                releaseNumberFromUser(ctx.chat.id);
                
                if (action === "used") {
                    removeNumberFromCountry(countryCode, oldNumber);
                    await saveNumbers(); // Save changes immediately
                }
                
                await displayNewNumber(ctx, countryCode);
                break;
            }

            case "check_otp_again": {
                const [number] = args;
                await ctx.deleteMessage().catch(() => {});
                await ctx.reply(`🔄 Checking OTP again for \`${number}\`...`, { parse_mode: "Markdown" });
                startOtpPolling(ctx, number);
                break;
            }
        }
        
        await ctx.answerCbQuery();

    } catch (error) {
        console.error("Error in callback_query handler:", error);
        if (!error.description?.includes("query is too old")) {
            await ctx.answerCbQuery("❌ An error occurred. Please try again.", { show_alert: true }).catch(() => {});
        }
    }
});


// --- Admin & Dev Commands ---

bot.command("adminlogin", (ctx) => {
  const password = ctx.message.text.split(" ")[1];
  if (password === ADMIN_PASSWORD) {
    ctx.session.isAdmin = true;
    ctx.reply("✅ Admin login successful!");
  } else {
    ctx.reply("❌ Incorrect password.");
  }
});

bot.command("devlogin", (ctx) => {
  const password = ctx.message.text.split(" ")[1];
  if (password === DEV_PASSWORD) {
    ctx.session.isDev = true;
    ctx.reply("✅ Developer access granted!");
  } else {
    ctx.reply("❌ Incorrect password.");
  }
});


bot.command("addcountry", async (ctx) => {
  if (!ctx.session?.isAdmin) return ctx.reply("Admin only.");
  const args = ctx.message.text.split(" ").slice(1);
  if (args.length < 3) return ctx.reply("Usage: /addcountry <code> <name> <flag>");
  const [code, ...nameParts] = args;
  const flag = nameParts.pop();
  const name = nameParts.join(" ");
  countries[code] = { name, flag };
  await saveCountries();
  ctx.reply(`Country added: ${flag} ${name} (${code})`);
});

bot.command("removecountry", async (ctx) => {
    if (!ctx.session?.isAdmin) return ctx.reply("Admin only.");
    const code = ctx.message.text.split(" ")[1];
    if (!code) return ctx.reply("Usage: /removecountry <code>");
    
    delete countries[code];
    delete numbersByCountry[code];
    
    await saveCountries();
    await saveNumbers();
    
    ctx.reply(`Country ${code} and all its associated numbers have been removed.`);
});

bot.command("deleteallnumbers", async (ctx) => {
  if (!ctx.session?.isAdmin) return ctx.reply("Admin only.");
  numbersByCountry = {};
  await saveNumbers();
  ctx.reply("All numbers have been deleted.");
});

bot.command("checknumbers", (ctx) => {
    if (!ctx.session?.isAdmin) return ctx.reply("Admin only.");
    let message = "📊 Number Availability:\n";
    for (const code in countries) {
        const count = numbersByCountry[code]?.length || 0;
        message += `${countries[code].flag} ${countries[code].name}: ${count} numbers\n`;
    }
    ctx.reply(message);
});

bot.on("document", async (ctx) => {
    if (!ctx.session?.isAdmin) return;
    if (!ctx.message.document.file_name.endsWith(".txt")) return ctx.reply("Please upload a .txt file.");

    try {
        const fileLink = await ctx.telegram.getFileLink(ctx.message.document.file_id);
        const response = await fetch(fileLink.href);
        const text = await response.text();
        const newNumbers = text.split(/\r?\n/).filter(line => line.trim());
        
        let addedCount = 0;
        let duplicateCount = 0;
        
        newNumbers.forEach(number => {
            const countryCode = getCountryCode(number);
            if (countryCode) {
                if (!numbersByCountry[countryCode]) {
                    numbersByCountry[countryCode] = [];
                }
                if (!numbersByCountry[countryCode].includes(number)) {
                    numbersByCountry[countryCode].push(number);
                    addedCount++;
                } else {
                    duplicateCount++;
                }
            }
        });

        await saveNumbers();
        ctx.reply(`✅ File processed. Added: ${addedCount}, Duplicates skipped: ${duplicateCount}.`);
    } catch (error) {
        console.error("Error processing uploaded file:", error);
        ctx.reply("❌ Failed to process the file.");
    }
});


// --- Puppeteer Scraper ---

async function startScraper() {
  let browser;
  try {
    console.log("Connecting to Chrome at http://localhost:9222...");
    browser = await puppeteer.connect({
      browserURL: "http://localhost:9222",
      defaultViewport: null,
    });

    const targetUrl = "http://185.2.83.39/ints/agent/SMSCDRStats";
    let targetPage = null;
    const pages = await browser.pages();
    targetPage = pages.find(p => p.url().includes(targetUrl));

    if (!targetPage) {
      console.warn("Target tab not found, opening a new one. Please log in manually if needed.");
      targetPage = await browser.newPage();
      await targetPage.goto(targetUrl, { waitUntil: "networkidle2" });
    }

    const uniqueRows = new Set();
    // Pre-load existing OTPs to avoid duplicates
    if (await fs.pathExists(OUTPUT_FILE)) {
      const existingData = await fs.readFile(OUTPUT_FILE, 'utf8');
      existingData.split('\n').forEach(line => {
        const match = line.match(/OTP Code: (\S+) Number: (\S+)/);
        if (match) uniqueRows.add(`${match[1]}_${match[2]}`);
      });
    }

    console.log(`Loaded ${uniqueRows.size} existing unique OTPs.`);

    const scrapeAndPrependData = async () => {
      try {
        await targetPage.reload({ waitUntil: "networkidle2" });
        if (!targetPage.url().includes(targetUrl)) {
            console.error("Redirected to login page. Please log in to the Chrome instance manually.");
            return;
        }

        const data = await targetPage.evaluate(() => {
          const table = document.querySelector("table#dt");
          if (!table) return [];
          return Array.from(table.querySelectorAll("tr"))
            .map(row => Array.from(row.querySelectorAll("td")).map(cell => cell.innerText.trim()))
            .filter(row => row.length > 5); // Ensure it's a valid data row
        });

        const newRows = [];
        data.forEach(columns => {
            const [date, range, number, service, , message] = columns;
            const otpMatch = message.match(/\b\d{4,8}\b/);
            if (!otpMatch) return;
            
            const otp = otpMatch[0];
            const uniqueKey = `${otp}_${number}`;

            if (!uniqueRows.has(uniqueKey)) {
                uniqueRows.add(uniqueKey);
                const countryCode = getCountryCode(number) || "";
                const countryInfo = countries[countryCode] || { name: range.split(" ")[0], flag: "🌍" };
                const formattedLine = `OTP Code: ${otp} Number: ${number} Country: ${countryInfo.name} ${countryInfo.flag} Service: ${service} Message: ${message} Date: ${date}`;
                newRows.push(formattedLine);
            }
        });

        if (newRows.length > 0) {
          const timestamp = new Date().toLocaleString("en-US", { timeZone: "Asia/Dhaka" });
          const dataToPrepend = `--- Data fetched at ${timestamp} ---\n${newRows.join("\n")}\n\n`;
          await fs.appendFile(OUTPUT_FILE, dataToPrepend);
          console.log(`Appended ${newRows.length} new rows to ${OUTPUT_FILE}`);
        } else {
            console.log("No new data to prepend.");
        }
      } catch (error) {
        console.error("Error during scraping:", error.message);
      }
    };

    await scrapeAndPrependData();
    setInterval(scrapeAndPrependData, 5000); // Scrape every 5 seconds

  } catch (error) {
    console.error("Critical error in scraper setup:", error);
    console.error("Could not connect to Chrome. Ensure it's running with remote debugging enabled on port 9222.");
  }
}

// --- Start the Bot ---

(async () => {
  await initialize();
  await startScraper();
  await bot.launch();
  console.log("Bot is running...");

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
})();