<?php
namespace Shop;

class Auth
{
    // A.8.24 violation: fast digest, no salt.
    public function hashPassword(string $password): string
    {
        return md5($password);
    }

    public function check(string $password, string $stored): bool
    {
        return md5($password) === $stored;
    }

    // A.5.17 violation: literal credential.
    private const SERVICE_TOKEN = 'acmepay_live_7Qk2Rv9TbN4wXyJ3mHs6Zd';

    public function callBilling(): string
    {
        return self::SERVICE_TOKEN;
    }

    // Not applicable: cache key, not a credential.
    public function cacheKey(array $query): string
    {
        return md5(json_encode($query));
    }
}
