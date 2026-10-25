#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <poll.h>
#include <liburing.h>

#define QUEUE_DEPTH 4
#define BUFFER_SIZE 1024

int main() {
    struct io_uring ring;
    io_uring_queue_init(QUEUE_DEPTH, &ring, 0);

    int fd = open("sample.txt", O_RDONLY);
    char buffer[BUFFER_SIZE] = {0};

    struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
    io_uring_prep_read(sqe, fd, buffer, BUFFER_SIZE - 1, 0);
    io_uring_sqe_set_data64(sqe, 999);

    // Submit the read request to the kernel
    io_uring_submit(&ring);

    printf("[epoll/poll test] Request submitted. Waiting for ring_fd (%d) to become readable via poll()...\n", ring.ring_fd);

    // Using standard poll() just like libuv's epoll loop does internally
    struct pollfd pfd;
    pfd.fd = ring.ring_fd;
    pfd.events = POLLIN;

    int poll_ret = poll(&pfd, 1, 5000); // wait up to 5 seconds
    if (poll_ret > 0 && (pfd.revents & POLLIN)) {
        printf("[epoll/poll test] Success! The io_uring descriptor woke up poll() with POLLIN!\n");

        struct io_uring_cqe *cqe;
        unsigned head;
        int count = 0;
        io_uring_for_each_cqe(&ring, head, cqe) {
            count++;
            printf("[epoll/poll test] Reaped CQE without blocking! ID: %llu, Bytes: %d\n",
                   (unsigned long long)cqe->user_data, cqe->res);
        }
        io_uring_cq_advance(&ring, count);
    } else {
        printf("[epoll/poll test] Timeout or error in poll.\n");
    }

    close(fd);
    io_uring_queue_exit(&ring);
    return 0;
}
