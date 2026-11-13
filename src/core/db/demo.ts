import type { Database } from "bun:sqlite";

export function seedDemo(db: Database): void {
  db.exec(`
    create table customers (
      id integer primary key,
      name text not null,
      email text not null unique,
      country text not null,
      created_at text not null
    );
    create table products (
      id integer primary key,
      name text not null,
      category text not null,
      price real not null
    );
    create table orders (
      id integer primary key,
      customer_id integer not null references customers(id),
      status text not null,
      ordered_at text not null
    );
    create table order_items (
      id integer primary key,
      order_id integer not null references orders(id),
      product_id integer not null references products(id),
      quantity integer not null,
      unit_price real not null
    );

    insert into customers (id, name, email, country, created_at) values
      (1, 'Ada Lovelace', 'ada@example.com', 'UK', '2026-01-10T09:15:00Z'),
      (2, 'Linus Torvalds', 'linus@example.com', 'FI', '2026-01-14T11:20:00Z'),
      (3, 'Grace Hopper', 'grace@example.com', 'US', '2026-01-22T14:05:00Z'),
      (4, 'Alan Turing', 'alan@example.com', 'UK', '2026-02-03T08:40:00Z'),
      (5, 'Barbara Liskov', 'barbara@example.com', 'US', '2026-02-11T16:30:00Z'),
      (6, 'Edsger Dijkstra', 'edsger@example.com', 'NL', '2026-02-19T10:00:00Z'),
      (7, 'Margaret Hamilton', 'margaret@example.com', 'US', '2026-03-01T13:45:00Z'),
      (8, 'Ken Thompson', 'ken@example.com', 'US', '2026-03-08T17:10:00Z');

    insert into products (id, name, category, price) values
      (1, 'Mechanical Keyboard', 'hardware', 149.00),
      (2, 'USB-C Dock', 'hardware', 89.50),
      (3, 'Ergonomic Mouse', 'hardware', 65.00),
      (4, 'SQL Pocket Guide', 'books', 24.00),
      (5, 'Relational Theory Book', 'books', 48.00),
      (6, 'Terminal Theme Pack', 'software', 15.00);

    insert into orders (id, customer_id, status, ordered_at) values
      (1, 1, 'delivered', '2026-03-10T10:00:00Z'),
      (2, 2, 'delivered', '2026-03-12T12:30:00Z'),
      (3, 3, 'delivered', '2026-03-15T09:45:00Z'),
      (4, 1, 'shipped', '2026-03-18T15:20:00Z'),
      (5, 4, 'delivered', '2026-03-20T11:10:00Z'),
      (6, 5, 'cancelled', '2026-03-22T14:00:00Z'),
      (7, 6, 'delivered', '2026-03-25T08:30:00Z'),
      (8, 7, 'shipped', '2026-03-28T16:15:00Z'),
      (9, 8, 'delivered', '2026-04-01T10:50:00Z'),
      (10, 2, 'pending', '2026-04-04T13:25:00Z'),
      (11, 5, 'delivered', '2026-04-07T09:05:00Z'),
      (12, 3, 'pending', '2026-04-10T18:40:00Z');

    insert into order_items (id, order_id, product_id, quantity, unit_price) values
      (1, 1, 1, 1, 149.00),
      (2, 1, 4, 2, 24.00),
      (3, 2, 2, 1, 89.50),
      (4, 2, 6, 1, 15.00),
      (5, 3, 5, 1, 48.00),
      (6, 3, 4, 1, 24.00),
      (7, 4, 3, 2, 65.00),
      (8, 4, 6, 1, 15.00),
      (9, 5, 1, 1, 149.00),
      (10, 5, 2, 1, 89.50),
      (11, 6, 3, 1, 65.00),
      (12, 6, 5, 1, 48.00),
      (13, 7, 4, 3, 24.00),
      (14, 7, 5, 2, 48.00),
      (15, 8, 1, 1, 149.00),
      (16, 8, 3, 1, 65.00),
      (17, 9, 2, 2, 89.50),
      (18, 9, 6, 1, 15.00),
      (19, 10, 5, 1, 48.00),
      (20, 10, 6, 2, 15.00),
      (21, 11, 1, 1, 149.00),
      (22, 11, 5, 1, 48.00),
      (23, 12, 2, 1, 89.50),
      (24, 12, 4, 1, 24.00);
  `);
}
