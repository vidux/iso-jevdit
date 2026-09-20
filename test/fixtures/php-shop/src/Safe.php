<?php
namespace Shop;

class Safe
{
    public function __construct(private \PDO $db) {}

    public function hashPassword(string $password): string
    {
        return password_hash($password, PASSWORD_ARGON2ID);
    }

    public function findByEmail(string $email): array
    {
        $stmt = $this->db->prepare('SELECT * FROM orders WHERE email = ?');
        $stmt->execute([$email]);
        return $stmt->fetchAll();
    }

    public function apiKey(): string
    {
        return getenv('BILLING_API_KEY') ?: '';
    }
}
