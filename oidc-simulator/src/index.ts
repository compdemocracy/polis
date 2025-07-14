import { simulation as createAuth0Simulator } from "@simulacrum/auth0-simulator";
import * as fs from "fs";
import * as path from "path";

// Configuration from environment variables
const AUTH_AUDIENCE = process.env.AUTH_AUDIENCE || "users";
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID || "dev-client-id";
const AUTH_SIMULATOR_PORT = parseInt(process.env.AUTH_SIMULATOR_PORT || "3000");
// Allow configurable issuer to handle Docker vs localhost access
const AUTH_ISSUER =
  process.env.AUTH_ISSUER || `https://localhost:${AUTH_SIMULATOR_PORT}/`;
// Certificate configuration - use environment variable or default
const CERT_DIR = process.env.CERT_DIR || "/root/.simulacrum/certs";

const CERT_FILE = path.join(CERT_DIR, "localhost.pem");
const KEY_FILE = path.join(CERT_DIR, "localhost-key.pem");

/**
 * Create a pool of test users for the simulator
 */
function createUserPool(size = 50): Array<{
  email: string;
  name: string;
  password: string;
  email_verified: boolean;
  user_id?: string;
  created_at?: string;
}> {
  const users: Array<{
    email: string;
    name: string;
    password: string;
    email_verified: boolean;
    user_id?: string;
    created_at?: string;
  }> = [];

  // Add specific test fixture users for standard users only (those who use OIDC)
  const standardUsers = [
    {
      email: "admin@polis.test",
      name: "Test Admin",
      password: "Te$tP@ssw0rd*",
    },
    {
      email: "moderator@polis.test",
      name: "Test Moderator",
      password: "Te$tP@ssw0rd*",
    },
  ];

  standardUsers.forEach((user, index) => {
    users.push({
      ...user,
      email_verified: true,
      user_id: `auth0|test_${index}`,
      created_at: new Date(
        Date.now() - (standardUsers.length - index) * 86400000
      ).toISOString(), // Stagger creation dates
    });
  });

  // Add additional test users
  for (let i = 0; i < size; i++) {
    users.push({
      email: `test.user.${i}@polis.test`,
      name: `Test User ${i}`,
      password: `Te$tP@ssw0rd*`,
      email_verified: true,
      user_id: `auth0|test_user_${i}`,
      created_at: new Date(Date.now() - i * 3600000).toISOString(), // Hourly stagger
    });
  }

  // Add JWT test user
  users.push({
    email: "jwt.test@polis.test",
    name: "JWT Test User",
    password: "Te$tP@ssw0rd*",
    email_verified: true,
    user_id: "auth0|jwt_test",
    created_at: new Date().toISOString(),
  });

  return users;
}

/**
 * Main function to start the simulator
 */
async function start() {
  try {
    console.log("Starting OIDC simulator...");

    // Check for certificate files
    console.log(`Checking for certificates in: ${CERT_DIR}`);
    if (fs.existsSync(CERT_DIR)) {
      console.log(`✅ Certificate directory found`);
      const certFiles = fs.readdirSync(CERT_DIR);
      console.log(`Certificate files available:`, certFiles);
      
      // Check for specific certificate files
      if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
        console.log(`✅ SSL certificates found:`, {
          cert: CERT_FILE,
          key: KEY_FILE
        });
      } else {
        console.log(`⚠️  Expected certificate files not found:`);
        console.log(`  Certificate: ${CERT_FILE} - ${fs.existsSync(CERT_FILE) ? 'Found' : 'Not found'}`);
        console.log(`  Private Key: ${KEY_FILE} - ${fs.existsSync(KEY_FILE) ? 'Found' : 'Not found'}`);
      }
    } else {
      console.log(`❌ Certificate directory not found: ${CERT_DIR}`);
    }

    // Create the OIDC simulator with a pool of test users
    const userPool = createUserPool(50);
    console.log("OIDC simulator user pool created:");
    console.table(userPool.slice(0, 10), [
      "email",
      "password",
      "user_id",
      "created_at",
    ]); // Show first 10 users

    // Path to rules directory - use relative path from current working directory
    const rulesDirectory = "rules";

    console.log(`Current working directory: ${process.cwd()}`);

    // Check if rules directory exists
    if (fs.existsSync(rulesDirectory)) {
      console.log(`✅ Rules directory found at: ${rulesDirectory}`);
      const ruleFiles = fs.readdirSync(rulesDirectory);
      console.log(
        `Found ${ruleFiles.length} files in rules directory:`,
        ruleFiles
      );
    } else {
      console.log(`⚠️  Rules directory not found at: ${rulesDirectory}`);
      console.log("OIDC simulator will run without custom rules");
    }

    // Configure simulator options with HTTPS
    const simulatorOptions: any = {
      options: {
        audience: AUTH_AUDIENCE,
        clientID: AUTH_CLIENT_ID,
        scope: "openid profile email",
        rulesDirectory: fs.existsSync(rulesDirectory)
          ? rulesDirectory
          : undefined,
      },
      initialState: {
        users: userPool,
      },
    };

    // Add HTTPS configuration if certificates are available
    if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
      console.log("Configuring HTTPS with certificates...");
      try {
        const cert = fs.readFileSync(CERT_FILE, 'utf8');
        const key = fs.readFileSync(KEY_FILE, 'utf8');
        console.log(`Certificate length: ${cert.length} chars`);
        console.log(`Private key length: ${key.length} chars`);
        
        // Try to configure HTTPS - this may or may not work depending on the simulator
        simulatorOptions.https = { cert, key };
      } catch (certError) {
        console.error("Error reading certificate files:", certError);
      }
    } else {
      console.log("⚠️  Certificates not found, the simulator will likely fail to start on HTTPS");
      console.log("   This is expected if certificates are not properly mounted");
    }

    const simulatorApp = createAuth0Simulator(simulatorOptions);

    // Start the simulator
    await simulatorApp.listen(AUTH_SIMULATOR_PORT);

    console.log(`OIDC Simulator started on HTTPS port ${AUTH_SIMULATOR_PORT}`);
    console.log(`Auth Issuer: ${AUTH_ISSUER}`);
    console.log(`JWKS URI: ${AUTH_ISSUER}.well-known/jwks.json`);
    console.log(`Auth Client ID: ${AUTH_CLIENT_ID}`);
    console.log(`Auth Audience: ${AUTH_AUDIENCE}`);
    console.log(`Pre-populated with ${userPool.length} test users`);
    console.log(
      `Standard users (OIDC): admin@polis.test, moderator@polis.test`
    );
    console.log(`Note: Participants use custom JWTs, not OIDC`);
    if (fs.existsSync(rulesDirectory)) {
      console.log(`✅ Custom namespace claims now supported via rules!`);
      console.log(`   Rules loaded from: ${rulesDirectory}`);
    } else {
      console.log(`⚠️  No rules loaded - custom claims not available`);
    }
  } catch (err) {
    console.error("Failed to start OIDC simulator:", err);
    process.exit(1);
  }
}

start();
