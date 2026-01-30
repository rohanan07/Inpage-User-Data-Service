console.log('Container booted, PID:', process.pid);

const express = require('express');
const cors = require('cors');
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

const app = express();
const PORT = process.env.PORT || 3000;
const TABLE_NAME = process.env.USER_WORDS_TABLE;

// 1. Initialize DynamoDB
// Region is auto-detected from the Fargate Task Metadata
const client = new DynamoDBClient({});
const dynamo = DynamoDBDocumentClient.from(client);

if (!TABLE_NAME) {
  console.warn('⚠️ USER_WORDS_TABLE env var is missing! Writes will fail.');
}

app.use(express.json());
app.use(cors());

// --- 👤 USER IDENTITY MIDDLEWARE ---
// Same middleware as other services to ensure we know WHO is saving data
app.use((req, res, next) => {
  const userId = req.headers['x-user-id'] || 'anonymous';
  const userEmail = req.headers['x-user-email'] || 'unknown';

  req.user = { id: userId, email: userEmail };

  console.log(`[user-data] 👤 Request from User: ${userId} (${req.method} ${req.url})`);
  next();
});
// -----------------------------------

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', service: 'user-data-service' });
});

// 🔹 POST /words: Save a list of words for a specific page
app.post('/userdata/words', async (req, res) => {
  const { bookId, pageNumber, words } = req.body;
  const userId = req.user.id;

  // Basic Validation
  if (!bookId || !pageNumber || !words || !Array.isArray(words)) {
    return res.status(400).json({ error: "Invalid payload. Required: bookId, pageNumber, words[]" });
  }

  if (userId === 'anonymous') {
    return res.status(401).json({ error: "Unauthorized. Missing x-user-id header." });
  }

  try {
    console.log(`[user-data] Saving ${words.length} words for User: ${userId}, Book: ${bookId}`);

    // Map each word to a DynamoDB Put Promise
    const savePromises = words.map(wordItem => {
      
      // Construct the Sort Key (SK)
      // Pattern: BOOK#<id>#PAGE#<num>#WORD#<word>
      // This groups data by Book -> Page -> Word automatically
      const sk = `BOOK#${bookId}#PAGE#${pageNumber}#WORD#${wordItem.word}`;

      const command = new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          userId: userId,             // Partition Key
          sk: sk,                     // Sort Key
          
          // Data Attributes
          bookId: bookId,
          pageNumber: pageNumber,
          word: wordItem.word,
          meaning: wordItem.meaning,
          example: wordItem.example,
          createdAt: Date.now()
        }
      });

      return dynamo.send(command);
    });

    // Execute all writes in parallel
    await Promise.all(savePromises);

    return res.status(201).json({
      message: `Successfully saved ${words.length} words`,
      bookId,
      pageNumber
    });

  } catch (error) {
    console.error('[user-data] Error saving words:', error);
    return res.status(500).json({ error: "Failed to save words to database" });
  }
});

// 🔹 GET /words: Fetch ALL words for the user
app.get('/userdata/words', async (req, res) => {
  const userId = req.user.id;

  if (userId === 'anonymous') {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const command = new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "userId = :uid",
      ExpressionAttributeValues: {
        ":uid": userId
      }
      // DynamoDB automatically sorts results by the Sort Key (sk)
      // So you get them ordered by Book, then Page, then Word.
    });

    const response = await dynamo.send(command);

    return res.json({
      count: response.Count,
      items: response.Items
    });

  } catch (error) {
    console.error('[user-data] Error fetching words:', error);
    return res.status(500).json({ error: "Failed to fetch user data" });
  }
});

app.listen(PORT, () => {
  console.log(`User Data Service running on port ${PORT}`);
});