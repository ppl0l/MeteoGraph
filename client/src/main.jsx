import React from 'react';
import ReactDOM from 'react-dom/client';
import { ApolloClient, InMemoryCache, split, HttpLink, ApolloProvider } from '@apollo/client';
import { getMainDefinition } from '@apollo/client/utilities';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { createClient } from 'graphql-ws';
import App from './App.jsx';
import './styles/index.css';

const client = new ApolloClient({
  link: split(
    ({ query }) => {
      const def = getMainDefinition(query);
      return def.kind === 'OperationDefinition' && def.operation === 'subscription';
    },
    new GraphQLWsLink(createClient({ url: 'ws://localhost:4000/graphql' })),
    new HttpLink({ uri: 'http://localhost:4000/graphql' })
  ),
  cache: new InMemoryCache()
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ApolloProvider client={client}>
      <App />
    </ApolloProvider>
  </React.StrictMode>
);
