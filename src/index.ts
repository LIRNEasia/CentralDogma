import { GraphQLFileLoader } from "@graphql-tools/graphql-file-loader";
import { loadSchema } from "@graphql-tools/load";
import { addResolversToSchema } from "@graphql-tools/schema";
import { ApolloServer } from "apollo-server-express";
import express from "express";
import { createServer } from "http";
import {
  Resolvers,
  ScrapeRequest,
  ScrapeReturnType,
  ScrapeStatusType,
} from "./generated/graphql";
import { v4 as uuidv4 } from "uuid";
import Redis from "ioredis";
import { execute, subscribe } from "graphql";
import { SubscriptionServer } from "subscriptions-transport-ws";
import { RedisPubSub } from "graphql-redis-subscriptions";
import { connect } from "amqplib";
import { Context } from "./context";
const responseList = [];
const options = {
  port: 6379,
  host: "redis",
};
const redis = new Redis({
  port: 6379,
  host: "redis",
});
const pubsub = new RedisPubSub({
  publisher: new Redis(options),
  subscriber: new Redis(options),
});

const q = "tasks.metacritic.requests";

const resolvers: Resolvers = {
  Query: {
    scrapeLength: () => responseList.length,
    scrapeStatus: async (_, { id }) => {
      const jsonResponse = (await redis.get(id)) ?? "{}";
      const response = JSON.parse(jsonResponse);
      return response;
    },
  },
  Mutation: {
    addMetaCriticScrapeRequest: (_, args, context) => {
      console.log(args);
      const response: ScrapeRequest = {
        id: uuidv4(),
        task: {
          url: args.url,
        },
        returnType: ScrapeReturnType.JSON,
        status: ScrapeStatusType.PENDING,
      };
      responseList.push(response);
      redis.set(response.id, JSON.stringify(response));
      context.taskQueue.sendToQueue(q, Buffer.from(JSON.stringify(response)), {
        persistent: true,
      });
      return response;
    },
  },
  Subscription: {
    scrapeStatus: {
      subscribe: (_, args) =>
        pubsub.asyncIterator([`tasks.metacritic.results.${args.id}`]),
    },
  },
};
async function main() {
  const app = express();
  const httpServer = createServer(app);

  const schema = await loadSchema("./src/schema.graphql", {
    loaders: [new GraphQLFileLoader()],
  });
  const connection = await connect("amqp://rabbitmq");
  const channel = await connection.createChannel();
  await channel.assertQueue(q, { durable: true });

  const schemaWithResolvers = addResolversToSchema(schema, resolvers);
  const server = new ApolloServer({
    schema: schemaWithResolvers,
    context: (): Context => ({
      taskQueue: channel,
    }),
    plugins: [
      {
        async serverWillStart() {
          return {
            async drainServer() {
              subscriptionServer.close();
            },
          };
        },
      },
    ],
  });

  const subscriptionServer = SubscriptionServer.create(
    {
      schema: schemaWithResolvers,
      execute,
      subscribe,
    },
    {
      server: httpServer,
      path: "/",
    }
  );

  await server.start();
  server.applyMiddleware({ app, path: "/" });
  await new Promise<void>((resolve) =>
    httpServer.listen({ port: 4000 }, resolve)
  );
  console.log(`🚀 Server ready at http://localhost:4000${server.graphqlPath}`);
}

main();
