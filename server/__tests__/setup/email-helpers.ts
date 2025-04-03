import http from 'node:http';

// Email interface types
interface EmailRecipient {
  address: string;
  name?: string;
}

interface EmailObject {
  id: string;
  subject: string;
  text: string;
  html?: string;
  to: EmailRecipient[];
  from: EmailRecipient;
  date: string;
  time?: Date;
  [key: string]: any;
}

interface FindEmailOptions {
  timeout?: number;
  interval?: number;
  maxAttempts?: number;
}

interface PasswordResetResult {
  url: string | null;
  token: string | null;
}

// MailDev server settings
const MAILDEV_HOST = process.env.MAILDEV_HOST || 'localhost';
const MAILDEV_PORT = process.env.MAILDEV_PORT || 1080;

/**
 * Get all emails from the MailDev server
 * @returns {Promise<EmailObject[]>} Array of email objects
 */
async function getEmails(): Promise<EmailObject[]> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: MAILDEV_HOST,
      port: MAILDEV_PORT,
      path: '/email',
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const emails = JSON.parse(data) as EmailObject[];
          resolve(emails);
        } catch (e) {
          if (e instanceof Error) {
            reject(new Error(`Failed to parse email response: ${e.message}`));
          } else {
            reject(new Error('Failed to parse email response'));
          }
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Failed to fetch emails: ${error.message}`));
    });

    req.end();
  });
}

/**
 * Get a specific email by its ID
 * @param {string} id - Email ID
 * @returns {Promise<EmailObject>} Email object
 */
async function getEmail(id: string): Promise<EmailObject> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: MAILDEV_HOST,
      port: MAILDEV_PORT,
      path: `/email/${id}`,
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const email = JSON.parse(data) as EmailObject;
          resolve(email);
        } catch (e) {
          if (e instanceof Error) {
            reject(new Error(`Failed to parse email response: ${e.message}`));
          } else {
            reject(new Error('Failed to parse email response'));
          }
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Failed to fetch email: ${error.message}`));
    });

    req.end();
  });
}

/**
 * Delete all emails from the MailDev server
 * @returns {Promise<void>}
 */
async function deleteAllEmails(): Promise<void> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: MAILDEV_HOST,
      port: MAILDEV_PORT,
      path: '/email/all',
      method: 'DELETE'
    };

    const req = http.request(options, (res) => {
      if (res.statusCode === 200) {
        resolve();
      } else {
        reject(new Error(`Failed to delete emails: status ${res.statusCode}`));
      }
    });

    req.on('error', (error) => {
      reject(new Error(`Failed to delete emails: ${error.message}`));
    });

    req.end();
  });
}

/**
 * Find the most recent email sent to a specific recipient
 * @param {string} recipient - Email address of the recipient
 * @param {FindEmailOptions} options - Additional options
 * @returns {Promise<EmailObject>} Email object
 */
async function findEmailByRecipient(
  recipient: string,
  options: FindEmailOptions = {}
): Promise<EmailObject> {
  const { timeout = 10000, interval = 1000, maxAttempts = 10 } = options;

  const startTime = Date.now();
  let attempts = 0;

  while (Date.now() - startTime < timeout && attempts < maxAttempts) {
    attempts++;

    try {
      const emails = await getEmails();
      const targetEmail = emails.find((email) =>
        email.to?.some((to) => to.address.toLowerCase() === recipient.toLowerCase())
      );

      if (targetEmail) {
        return await getEmail(targetEmail.id);
      }
    } catch (error) {
      console.warn(`Error fetching emails (attempt ${attempts}): ${error.message}`);
    }

    if (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  throw new Error(`No email found for recipient ${recipient} after ${attempts} attempts`);
}

/**
 * Extract the password reset URL and token from an email
 * @param {EmailObject} email - Email object from MailDev
 * @returns {PasswordResetResult} Object with url and token properties or null values if not found
 */
function extractPasswordResetUrl(email: EmailObject): PasswordResetResult {
  if (email?.text) {
    let token: string | null = null;
    let url: string | null = null;

    const urlMatch = email.text.match(/(https?:\/\/[^\s]+pwreset\/([a-zA-Z0-9_-]+))/);

    if (urlMatch?.[1]) {
      url = urlMatch[1];
      token = urlMatch[2];
    }

    return { url, token };
  }

  return { url: null, token: null };
}

/**
 * Get the password reset URL for a specific recipient
 * @param {string} recipient - Email address of the recipient
 * @param {FindEmailOptions} options - Options for email fetching
 * @returns {Promise<PasswordResetResult>} Object with url and token properties
 */
async function getPasswordResetUrl(recipient: string, options: FindEmailOptions = {}): Promise<PasswordResetResult> {
  const email = await findEmailByRecipient(recipient, options);
  const result = extractPasswordResetUrl(email);
  
  if (!result.url) {
    throw new Error('Password reset URL not found in email');
  }

  return result;
}

export { deleteAllEmails, findEmailByRecipient, getEmail, getEmails, getPasswordResetUrl };
export type { EmailObject, EmailRecipient, FindEmailOptions, PasswordResetResult };
